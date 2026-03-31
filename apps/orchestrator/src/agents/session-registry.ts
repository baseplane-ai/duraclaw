import { Agent } from 'agents'
import type { Env, RegistryState, SessionSummary } from '~/lib/types'

/**
 * SessionRegistry — singleton DO that tracks active sessions and
 * worktree locks.
 *
 * This is a lightweight index, not a state store. Session state lives
 * in individual SessionAgent DOs. The registry exists to:
 * 1. Enforce one-session-per-worktree via locks
 * 2. Provide a list of all sessions for the dashboard
 */
export class SessionRegistry extends Agent<Env, RegistryState> {
  initialState: RegistryState = {
    worktree_locks: {},
  }

  async onStart() {
    // Create session index table if needed
    this.sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`

    // Schedule periodic cleanup of stale locks
    await this.scheduleEvery(300, 'cleanupStaleLocks')
  }

  // ── Scheduled Callbacks ───────────────────────────────────────

  async cleanupStaleLocks() {
    console.log('[SessionRegistry] cleanupStaleLocks')
    const locks = this.state.worktree_locks
    for (const [worktree, sessionId] of Object.entries(locks)) {
      try {
        const stub = this.env.SESSION_AGENT.get(this.env.SESSION_AGENT.idFromString(sessionId))
        // Call getSessionState via RPC - the Agents SDK supports this
        const state = await (stub as any).getSessionState()
        if (state.status !== 'running') {
          await this.releaseWorktree(worktree)
          await this.updateSessionStatus(sessionId, state.status)
        }
      } catch {
        // Session DO might not exist anymore - release the lock
        await this.releaseWorktree(worktree)
      }
    }
  }

  // ── Worktree Locking ──────────────────────────────────────────

  async acquireWorktree(worktree: string, sessionId: string): Promise<boolean> {
    const existing = this.state.worktree_locks[worktree]
    if (existing) return false

    this.setState({
      worktree_locks: { ...this.state.worktree_locks, [worktree]: sessionId },
    })
    return true
  }

  async releaseWorktree(worktree: string): Promise<void> {
    const { [worktree]: _, ...rest } = this.state.worktree_locks
    this.setState({ worktree_locks: rest })
  }

  async getWorktreeLocks(): Promise<Record<string, string>> {
    return this.state.worktree_locks
  }

  // ── Session Index ─────────────────────────────────────────────

  async registerSession(session: SessionSummary): Promise<void> {
    this.sql`INSERT OR REPLACE INTO sessions (id, worktree, status, model, created_at, updated_at)
      VALUES (${session.id}, ${session.worktree}, ${session.status}, ${session.model}, ${session.created_at}, ${session.updated_at})`
  }

  async updateSessionStatus(sessionId: string, status: string): Promise<void> {
    const now = new Date().toISOString()
    this.sql`UPDATE sessions SET status = ${status}, updated_at = ${now} WHERE id = ${sessionId}`
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sql`DELETE FROM sessions WHERE id = ${sessionId}`
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.sql<SessionSummary>`SELECT * FROM sessions ORDER BY updated_at DESC`
  }

  async listActiveSessions(): Promise<SessionSummary[]> {
    return this
      .sql<SessionSummary>`SELECT * FROM sessions WHERE status = 'running' ORDER BY created_at DESC`
  }
}
