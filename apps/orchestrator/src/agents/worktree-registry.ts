import { Agent } from 'agents'
import type { Env, RegistryState } from '~/lib/types'
import type { SessionSummary } from '~/lib/types'

export class WorktreeRegistry extends Agent<Env, RegistryState> {
  initialState: RegistryState = {
    worktree_locks: {},
  }

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS sessions (
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
    )`

    await this.scheduleEvery(300, 'cleanupStaleLocks')
  }

  async cleanupStaleLocks() {
    console.log('[WorktreeRegistry] cleanupStaleLocks')
    const locks = this.state.worktree_locks
    for (const [worktree, sessionId] of Object.entries(locks)) {
      try {
        const stub = this.env.SESSION_AGENT.get(
          this.env.SESSION_AGENT.idFromString(sessionId),
        )
        const state = await (stub as any).getSessionState()
        const activeStates = ['running', 'waiting_input', 'waiting_permission']
        if (!activeStates.includes(state.status)) {
          await this.releaseWorktree(worktree)
          await this.updateSessionStatus(sessionId, state.status)
        }
      } catch {
        await this.releaseWorktree(worktree)
      }
    }
  }

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

  async registerSession(session: SessionSummary): Promise<void> {
    this.sql`INSERT OR REPLACE INTO sessions (id, worktree, status, model, created_at, updated_at, prompt)
      VALUES (${session.id}, ${session.worktree}, ${session.status}, ${session.model}, ${session.created_at}, ${session.updated_at}, ${session.prompt ?? null})`
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
    return this.sql<SessionSummary>`SELECT * FROM sessions WHERE status IN ('running', 'waiting_input', 'waiting_permission') ORDER BY created_at DESC`
  }

  async listSessionsByWorktree(worktree: string): Promise<SessionSummary[]> {
    return this.sql<SessionSummary>`SELECT * FROM sessions WHERE worktree = ${worktree} ORDER BY created_at DESC`
  }
}
