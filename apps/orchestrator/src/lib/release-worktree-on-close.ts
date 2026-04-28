import { and, eq, ne } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { agentSessions, worktrees } from '~/db/schema'

type DB = DrizzleD1Database<typeof schema>

/**
 * D1 `agent_sessions.status` values that count as "session is no longer
 * holding the worktree." Any sibling row whose status is NOT in this
 * set is treated as still-active and blocks the release.
 *
 * Note: the D1 row's `status` column never actually carries
 * `'completed'` / `'stopped'` / `'failed'` / `'crashed'` in this
 * codebase — finished sessions park at `'idle'` (see comment at
 * `apps/orchestrator/src/agents/session-do/mode-transition.ts:269`).
 * The full set is enumerated for forward-compat with adapters that
 * may surface those values, and to mirror the literal status names
 * in spec §B-LIFECYCLE-2.
 */
const TERMINAL_STATUSES = new Set(['idle', 'completed', 'error', 'stopped', 'failed', 'crashed'])

/**
 * GH#115 §B-LIFECYCLE-2: release a worktree on session close.
 *
 * Last-session check: only flip the worktree to `cleanup` if no other
 * `agent_sessions` row with the same `worktreeId` is still in
 * non-terminal status. This handles the arc-shared chain case where
 * a successor session is already running on the same clone — closing
 * the predecessor must NOT release the clone out from under the
 * successor.
 *
 * Idempotent: re-flipping an already-`cleanup` row simply re-stamps
 * `releasedAt` and `lastTouchedAt` to `now`. The janitor's grace
 * window is measured from the latest `releasedAt`, so a noisy close
 * path can't accidentally short-circuit the grace window.
 *
 * Best-effort: caller wraps in try/catch and logs — a failed release
 * does not crash the close path. The cron janitor is the always-on
 * safety net.
 */
export async function releaseWorktreeOnClose(
  db: DB,
  sessionId: string,
  worktreeId: string,
): Promise<{ released: boolean }> {
  const siblings = await db
    .select({ id: agentSessions.id, status: agentSessions.status })
    .from(agentSessions)
    .where(and(eq(agentSessions.worktreeId, worktreeId), ne(agentSessions.id, sessionId)))

  const stillActive = siblings.some((s) => !TERMINAL_STATUSES.has(s.status))
  if (stillActive) return { released: false }

  const now = Date.now()
  await db
    .update(worktrees)
    .set({ releasedAt: now, status: 'cleanup', lastTouchedAt: now })
    .where(eq(worktrees.id, worktreeId))
  return { released: true }
}
