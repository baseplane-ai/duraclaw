import { DurableObject } from 'cloudflare:workers'
import type { Env, SessionSummary } from '~/lib/types'

export class ProjectRegistry extends DurableObject<Env> {
  private initialized = false

  private async ensureInit() {
    if (this.initialized) return
    this.initialized = true

    // Run migrations (idempotent — will fail silently if already applied)
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE sessions RENAME COLUMN worktree TO project`)
    } catch {
      // Already renamed or table doesn't exist yet
    }

    try {
      this.ctx.storage.sql.exec(`ALTER TABLE sessions ADD COLUMN summary TEXT`)
    } catch {
      // Already added or table doesn't exist yet
    }

    // Create sessions table
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER,
      total_cost_usd REAL,
      num_turns INTEGER,
      prompt TEXT,
      summary TEXT
    )`)

    // Clean up legacy lock state
    await this.ctx.storage.delete('state')
  }

  async registerSession(session: SessionSummary): Promise<void> {
    await this.ensureInit()
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO sessions (id, project, status, model, created_at, updated_at, prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      session.id, session.project, session.status, session.model,
      session.created_at, session.updated_at, session.prompt ?? null,
    )
  }

  async updateSessionStatus(sessionId: string, status: string): Promise<void> {
    await this.ensureInit()
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`,
      status, now, sessionId,
    )
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.ensureInit()
    this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, sessionId)
  }

  async updateSessionResult(sessionId: string, result: {
    summary?: string | null
    duration_ms?: number | null
    total_cost_usd?: number | null
    num_turns?: number | null
  }): Promise<void> {
    await this.ensureInit()
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET summary = ?, duration_ms = ?, total_cost_usd = ?, num_turns = ?, updated_at = ? WHERE id = ?`,
      result.summary ?? null, result.duration_ms ?? null, result.total_cost_usd ?? null,
      result.num_turns ?? null, now, sessionId,
    )
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.ensureInit()
    return this.ctx.storage.sql.exec(
      `SELECT * FROM sessions ORDER BY updated_at DESC`,
    ).toArray() as unknown as SessionSummary[]
  }

  async listActiveSessions(): Promise<SessionSummary[]> {
    await this.ensureInit()
    return this.ctx.storage.sql.exec(
      `SELECT * FROM sessions WHERE status IN ('running', 'waiting_input', 'waiting_permission') ORDER BY created_at DESC`,
    ).toArray() as unknown as SessionSummary[]
  }

  async listSessionsByProject(project: string): Promise<SessionSummary[]> {
    await this.ensureInit()
    return this.ctx.storage.sql.exec(
      `SELECT * FROM sessions WHERE project = ? ORDER BY created_at DESC`,
      project,
    ).toArray() as unknown as SessionSummary[]
  }
}
