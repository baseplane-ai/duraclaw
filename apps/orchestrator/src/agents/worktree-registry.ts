import { DurableObject } from 'cloudflare:workers'
import type { Env, SessionSummary } from '~/lib/types'

export class WorktreeRegistry extends DurableObject<Env> {
  private initialized = false

  private async ensureInit() {
    if (this.initialized) return
    this.initialized = true

    // Create sessions table
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER,
      total_cost_usd REAL,
      num_turns INTEGER,
      prompt TEXT
    )`)

    // Clean up legacy lock state
    await this.ctx.storage.delete('state')
  }

  async registerSession(session: SessionSummary): Promise<void> {
    await this.ensureInit()
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO sessions (id, worktree, status, model, created_at, updated_at, prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      session.id, session.worktree, session.status, session.model,
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

  async listSessionsByWorktree(worktree: string): Promise<SessionSummary[]> {
    await this.ensureInit()
    return this.ctx.storage.sql.exec(
      `SELECT * FROM sessions WHERE worktree = ? ORDER BY created_at DESC`,
      worktree,
    ).toArray() as unknown as SessionSummary[]
  }
}
