import { DurableObject } from 'cloudflare:workers'
import { runMigrations } from '~/lib/do-migrations'
import type { DiscoveredSession, Env, SessionSummary, UserPreferences } from '~/lib/types'
import { REGISTRY_MIGRATIONS } from './project-registry-migrations'

export class ProjectRegistry extends DurableObject<Env> {
  private initialized = false
  private inAlarm = false

  private async ensureInit() {
    if (this.initialized) return
    this.initialized = true

    runMigrations(this.ctx.storage.sql, REGISTRY_MIGRATIONS)
    // Clean up legacy lock state
    await this.ctx.storage.delete('state')

    // Schedule discovery alarm if not already set (skip when called from alarm handler)
    if (!this.inAlarm) {
      const currentAlarm = await this.ctx.storage.getAlarm()
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000)
      }
    }
  }

  async alarm(): Promise<void> {
    this.inAlarm = true
    await this.ensureInit()
    this.inAlarm = false

    try {
      const gatewayUrl = this.env.CC_GATEWAY_URL
      if (!gatewayUrl) {
        console.log('[ProjectRegistry] No CC_GATEWAY_URL configured, skipping discovery sync')
        return
      }

      // Get watermark — default to 7 days ago
      const watermark =
        ((await this.ctx.storage.get('sync_watermark')) as string) ??
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

      const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
      const discoverUrl = new URL('/sessions/discover', httpBase)
      discoverUrl.searchParams.set('since', watermark)

      const headers: Record<string, string> = {}
      if (this.env.CC_GATEWAY_SECRET) {
        headers.Authorization = `Bearer ${this.env.CC_GATEWAY_SECRET}`
      }

      const resp = await fetch(discoverUrl.toString(), { headers })
      if (!resp.ok) {
        console.error(`[ProjectRegistry] Gateway returned ${resp.status} during discovery sync`)
        return
      }

      const data = (await resp.json()) as { sessions: DiscoveredSession[] }
      if (data.sessions.length > 0) {
        // Use a placeholder userId — discovered sessions are single-user VPS model
        const userId = 'system'
        const result = await this.syncDiscoveredSessions(userId, data.sessions)
        console.log(
          `[ProjectRegistry] Discovery sync: ${result.inserted} inserted, ${result.updated} updated`,
        )

        // Update watermark
        if (result.watermark) {
          await this.ctx.storage.put('sync_watermark', result.watermark)
        }
      }
    } catch (err) {
      console.error('[ProjectRegistry] Discovery sync failed:', err)
    } finally {
      // Always reschedule — alarms fire once, must reschedule for recurring behavior
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000)
    }
  }

  async registerSession(session: SessionSummary): Promise<void> {
    await this.ensureInit()
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO sessions (id, user_id, project, status, model, created_at, updated_at, last_activity, prompt, origin, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'duraclaw', 'claude')`,
      session.id,
      session.userId ?? null,
      session.project,
      session.status,
      session.model,
      session.created_at,
      session.updated_at,
      session.last_activity ?? session.updated_at,
      session.prompt ?? null,
    )
  }

  async updateSessionStatus(sessionId: string, status: string): Promise<void> {
    await this.ensureInit()
    const now = new Date().toISOString()
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET status = ?, updated_at = ?, last_activity = ? WHERE id = ?`,
      status,
      now,
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
      `UPDATE sessions SET summary = ?, duration_ms = ?, total_cost_usd = ?, num_turns = ?, updated_at = ?, last_activity = ? WHERE id = ?`,
      result.summary ?? null,
      result.duration_ms ?? null,
      result.total_cost_usd ?? null,
      result.num_turns ?? null,
      now,
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
         last_activity,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         origin,
         agent,
         message_count,
         sdk_session_id,
         kata_mode,
         kata_issue,
         kata_phase
       FROM sessions
       WHERE id = ?
       LIMIT 1`,
        sessionId,
      )
      .toArray() as unknown as SessionSummary[]
    return rows[0] ?? null
  }

  async listSessions(_userId: string): Promise<SessionSummary[]> {
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
         last_activity,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         archived,
         origin,
         agent,
         message_count,
         sdk_session_id,
         kata_mode,
         kata_issue,
         kata_phase
       FROM sessions
       ORDER BY COALESCE(last_activity, updated_at) DESC`,
      )
      .toArray() as unknown as SessionSummary[]
  }

  async listActiveSessions(_userId: string): Promise<SessionSummary[]> {
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
       WHERE status IN ('running', 'waiting_input', 'waiting_permission')
       ORDER BY created_at DESC`,
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
      'origin',
      'agent',
      'message_count',
      'sdk_session_id',
      'kata_mode',
      'kata_issue',
      'kata_phase',
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

  async searchSessions(_userId: string, query: string): Promise<SessionSummary[]> {
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
         last_activity,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         archived,
         origin,
         agent,
         message_count,
         sdk_session_id
       FROM sessions
       WHERE (prompt LIKE ? OR project LIKE ? OR id LIKE ? OR title LIKE ? OR summary LIKE ? OR agent LIKE ? OR sdk_session_id LIKE ?)
       ORDER BY COALESCE(last_activity, updated_at) DESC`,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      )
      .toArray() as unknown as SessionSummary[]
  }

  async listSessionsPaginated(
    _userId: string,
    opts: {
      sortBy?:
        | 'updated_at'
        | 'created_at'
        | 'last_activity'
        | 'total_cost_usd'
        | 'duration_ms'
        | 'num_turns'
      sortDir?: 'asc' | 'desc'
      status?: string
      project?: string
      model?: string
      limit?: number
      offset?: number
    },
  ): Promise<{ sessions: SessionSummary[]; total: number }> {
    await this.ensureInit()
    const conditions: string[] = ['1 = 1']
    const params: unknown[] = []

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
    const sortCol = opts.sortBy ?? 'last_activity'
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
         last_activity,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         archived,
         origin,
         agent,
         message_count,
         sdk_session_id
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

  async listSessionsByProject(project: string, _userId: string): Promise<SessionSummary[]> {
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
         last_activity,
         duration_ms,
         total_cost_usd,
         num_turns,
         prompt,
         summary,
         title,
         tag,
         origin,
         agent,
         message_count,
         sdk_session_id
       FROM sessions
       WHERE project = ?
       ORDER BY COALESCE(last_activity, updated_at) DESC`,
        project,
      )
      .toArray() as unknown as SessionSummary[]
  }

  async syncDiscoveredSessions(
    userId: string,
    sessions: DiscoveredSession[],
  ): Promise<{ inserted: number; updated: number; watermark: string }> {
    await this.ensureInit()
    let inserted = 0
    let updated = 0
    let watermark = ''

    for (const s of sessions) {
      // Track latest activity for watermark
      if (s.last_activity > watermark) {
        watermark = s.last_activity
      }

      // Check if session exists by sdk_session_id
      const existing = this.ctx.storage.sql
        .exec(`SELECT id, origin FROM sessions WHERE sdk_session_id = ? LIMIT 1`, s.sdk_session_id)
        .toArray()

      if (existing.length > 0) {
        // Update existing session — preserve Duraclaw-specific fields (cost, model, status)
        this.ctx.storage.sql.exec(
          `UPDATE sessions SET
            updated_at = CASE WHEN ? > COALESCE(updated_at, '') THEN ? ELSE updated_at END,
            last_activity = CASE WHEN ? > COALESCE(last_activity, '') THEN ? ELSE last_activity END,
            summary = COALESCE(?, summary),
            tag = COALESCE(?, tag),
            title = COALESCE(?, title),
            message_count = COALESCE(?, message_count),
            agent = COALESCE(?, agent)
          WHERE sdk_session_id = ?`,
          s.last_activity,
          s.last_activity,
          s.last_activity,
          s.last_activity,
          s.summary || null,
          s.tag,
          s.title,
          s.message_count,
          s.agent,
          s.sdk_session_id,
        )
        updated++
        continue
      }

      // Check for fuzzy match: same project + user + created_at within 60s
      const fuzzy = this.ctx.storage.sql
        .exec(
          `SELECT id FROM sessions
           WHERE project = ?
             AND user_id = ?
             AND ABS(strftime('%s', created_at) - strftime('%s', ?)) < 60
             AND sdk_session_id IS NULL
           ORDER BY ABS(strftime('%s', created_at) - strftime('%s', ?)) ASC
           LIMIT 1`,
          s.project,
          userId,
          s.started_at,
          s.started_at,
        )
        .toArray()

      if (fuzzy.length > 0) {
        // Update the matching session with discovered data
        const matchId = (fuzzy[0] as { id: string }).id
        this.ctx.storage.sql.exec(
          `UPDATE sessions SET
            sdk_session_id = ?,
            origin = CASE WHEN origin = 'duraclaw' THEN origin ELSE 'discovered' END,
            agent = ?,
            last_activity = CASE WHEN ? > COALESCE(last_activity, '') THEN ? ELSE last_activity END,
            summary = COALESCE(?, summary),
            tag = COALESCE(?, tag),
            title = COALESCE(?, title),
            message_count = ?
          WHERE id = ?`,
          s.sdk_session_id,
          s.agent,
          s.last_activity,
          s.last_activity,
          s.summary || null,
          s.tag,
          s.title,
          s.message_count,
          matchId,
        )
        updated++
        continue
      }

      // Insert new discovered session
      const id = s.sdk_session_id // Use sdk_session_id as the row ID
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (id, user_id, project, status, model, created_at, updated_at, last_activity, origin, agent, sdk_session_id, summary, tag, title, message_count)
         VALUES (?, ?, ?, 'idle', NULL, ?, ?, ?, 'discovered', ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        s.project,
        s.started_at,
        s.last_activity,
        s.last_activity,
        s.agent,
        s.sdk_session_id,
        s.summary || null,
        s.tag,
        s.title,
        s.message_count,
      )
      inserted++
    }

    return { inserted, updated, watermark }
  }

  async getUserPreferences(userId: string): Promise<UserPreferences | null> {
    await this.ensureInit()
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM user_preferences WHERE user_id = ?', userId)
      .toArray()
    if (rows.length === 0) return null
    const row = rows[0]
    return {
      permission_mode: row.permission_mode as string,
      model: row.model as string,
      max_budget: row.max_budget as number | null,
      thinking_mode: row.thinking_mode as string,
      effort: row.effort as string,
    }
  }

  async setUserPreferences(userId: string, prefs: Partial<UserPreferences>): Promise<void> {
    await this.ensureInit()
    const allowedFields = ['permission_mode', 'model', 'max_budget', 'thinking_mode', 'effort']
    const existing = this.ctx.storage.sql
      .exec('SELECT user_id FROM user_preferences WHERE user_id = ?', userId)
      .toArray()

    if (existing.length > 0) {
      const updates: string[] = []
      const values: unknown[] = []
      for (const [key, value] of Object.entries(prefs)) {
        if (allowedFields.includes(key)) {
          updates.push(`${key} = ?`)
          values.push(value)
        }
      }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')")
        values.push(userId)
        this.ctx.storage.sql.exec(
          `UPDATE user_preferences SET ${updates.join(', ')} WHERE user_id = ?`,
          ...values,
        )
      }
    } else {
      const cols = ['user_id']
      const vals: unknown[] = [userId]
      const placeholders = ['?']
      for (const [key, value] of Object.entries(prefs)) {
        if (allowedFields.includes(key)) {
          cols.push(key)
          vals.push(value)
          placeholders.push('?')
        }
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO user_preferences (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
        ...vals,
      )
    }
  }
}
