import { DurableObject } from 'cloudflare:workers'
import { runMigrations } from '~/lib/do-migrations'
import type { Env, SessionSummary } from '~/lib/types'
import { REGISTRY_MIGRATIONS } from './project-registry-migrations'

export class ProjectRegistry extends DurableObject<Env> {
  private initialized = false

  private async ensureInit() {
    if (this.initialized) return
    this.initialized = true

    runMigrations(this.ctx.storage.sql, REGISTRY_MIGRATIONS)
    // Clean up legacy lock state
    await this.ctx.storage.delete('state')
  }

  async registerSession(session: SessionSummary): Promise<void> {
    await this.ensureInit()
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO sessions (id, user_id, project, status, model, created_at, updated_at, prompt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.userId ?? null,
      session.project,
      session.status,
      session.model,
      session.created_at,
      session.updated_at,
      session.prompt ?? null,
    )
  }

  async updateSessionStatus(sessionId: string, status: string): Promise<void> {
    await this.ensureInit()
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`,
      status,
      now,
      sessionId,
    )
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.ensureInit()
    this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, sessionId)
  }

  async updateSessionResult(
    sessionId: string,
    result: {
      summary?: string | null
      duration_ms?: number | null
      total_cost_usd?: number | null
      num_turns?: number | null
    },
  ): Promise<void> {
    await this.ensureInit()
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET summary = ?, duration_ms = ?, total_cost_usd = ?, num_turns = ?, updated_at = ? WHERE id = ?`,
      result.summary ?? null,
      result.duration_ms ?? null,
      result.total_cost_usd ?? null,
      result.num_turns ?? null,
      now,
      sessionId,
    )
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    await this.ensureInit()
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT
         id,
         user_id AS userId,
         project,
         status,
         model,
         created_at,
         updated_at,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag
       FROM sessions
       WHERE id = ?
       LIMIT 1`,
        sessionId,
      )
      .toArray() as unknown as SessionSummary[]
    return rows[0] ?? null
  }

  async listSessions(userId: string): Promise<SessionSummary[]> {
    await this.ensureInit()
    return this.ctx.storage.sql
      .exec(
        `SELECT
         id,
         user_id AS userId,
         project,
         status,
         model,
         created_at,
         updated_at,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         archived
       FROM sessions
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
        userId,
      )
      .toArray() as unknown as SessionSummary[]
  }

  async listActiveSessions(userId: string): Promise<SessionSummary[]> {
    await this.ensureInit()
    return this.ctx.storage.sql
      .exec(
        `SELECT
         id,
         user_id AS userId,
         project,
         status,
         model,
         created_at,
         updated_at,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary
       FROM sessions
       WHERE user_id = ?
         AND status IN ('running', 'waiting_input', 'waiting_permission')
       ORDER BY created_at DESC`,
        userId,
      )
      .toArray() as unknown as SessionSummary[]
  }

  async updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    await this.ensureInit()
    const now = new Date().toISOString()
    const setClauses: string[] = ['updated_at = ?']
    const values: unknown[] = [now]

    const allowedFields = [
      'status',
      'model',
      'prompt',
      'summary',
      'title',
      'tag',
      'duration_ms',
      'total_cost_usd',
      'num_turns',
      'archived',
    ]
    for (const field of allowedFields) {
      if (field in updates) {
        setClauses.push(`${field} = ?`)
        values.push(updates[field])
      }
    }

    values.push(sessionId)
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`,
      ...values,
    )
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.ensureInit()
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET archived = 1, updated_at = ? WHERE id = ?`,
      now,
      sessionId,
    )
  }

  async searchSessions(userId: string, query: string): Promise<SessionSummary[]> {
    await this.ensureInit()
    const pattern = `%${query}%`
    return this.ctx.storage.sql
      .exec(
        `SELECT
         id,
         user_id AS userId,
         project,
         status,
         model,
         created_at,
         updated_at,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         archived
       FROM sessions
       WHERE user_id = ?
         AND (prompt LIKE ? OR project LIKE ? OR id LIKE ? OR title LIKE ? OR summary LIKE ?)
       ORDER BY updated_at DESC`,
        userId,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      )
      .toArray() as unknown as SessionSummary[]
  }

  async listSessionsPaginated(
    userId: string,
    opts: {
      sortBy?: 'updated_at' | 'created_at' | 'total_cost_usd' | 'duration_ms' | 'num_turns'
      sortDir?: 'asc' | 'desc'
      status?: string
      project?: string
      model?: string
      limit?: number
      offset?: number
    },
  ): Promise<{ sessions: SessionSummary[]; total: number }> {
    await this.ensureInit()
    const conditions: string[] = ['user_id = ?']
    const params: unknown[] = [userId]

    if (opts.status) {
      conditions.push('status = ?')
      params.push(opts.status)
    }
    if (opts.project) {
      conditions.push('project = ?')
      params.push(opts.project)
    }
    if (opts.model) {
      conditions.push('model = ?')
      params.push(opts.model)
    }

    const where = conditions.join(' AND ')
    const sortCol = opts.sortBy ?? 'updated_at'
    const sortDir = opts.sortDir === 'asc' ? 'ASC' : 'DESC'
    const limit = opts.limit ?? 50
    const offset = opts.offset ?? 0

    const total = (
      this.ctx.storage.sql
        .exec(`SELECT COUNT(*) as cnt FROM sessions WHERE ${where}`, ...params)
        .toArray()[0] as { cnt: number }
    ).cnt

    const sessions = this.ctx.storage.sql
      .exec(
        `SELECT
         id,
         user_id AS userId,
         project,
         status,
         model,
         created_at,
         updated_at,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         archived
       FROM sessions
       WHERE ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      )
      .toArray() as unknown as SessionSummary[]

    return { sessions, total }
  }

  async listSessionsByProject(project: string, userId: string): Promise<SessionSummary[]> {
    await this.ensureInit()
    return this.ctx.storage.sql
      .exec(
        `SELECT
         id,
         user_id AS userId,
         project,
         status,
         model,
         created_at,
         updated_at,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary
       FROM sessions
       WHERE project = ?
         AND user_id = ?
       ORDER BY created_at DESC`,
        project,
        userId,
      )
      .toArray() as unknown as SessionSummary[]
  }
}
