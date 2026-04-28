import { and, isNotNull, lt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { worktrees } from '~/db/schema'
import type { Env } from '~/lib/types'

/**
 * Default 24h idle window after `releasedAt` before the janitor
 * hard-deletes a worktree row. Configurable via env
 * `CC_WORKTREE_IDLE_WINDOW_SECS`.
 */
const DEFAULT_IDLE_WINDOW_SECS = 24 * 60 * 60

/**
 * GH#115 P1.7 §B-JANITOR-1/2: idle-window resolution.
 *
 * The same value is used by:
 *   • the worker cron (this file)
 *   • the admin sweep endpoint (`/api/admin/worktrees/sweep`)
 *   • SessionDO's release-on-close path (B-LIFECYCLE-2)
 *
 * Per spec §"Open Risks" #4 the implementation collapses the
 * separate DO-alarm layer (B-JANITOR-1) into the always-on cron +
 * admin sweep. The DO alarm slot in this codebase is already owned
 * by the watchdog / recovery-grace state machines and arbitrating
 * multiple consumers is unjustified for v1; the manual sweep is
 * always-available as escape hatch.
 */
export function getIdleWindowMs(env: Env): number {
  const raw = (env as unknown as { CC_WORKTREE_IDLE_WINDOW_SECS?: string })
    .CC_WORKTREE_IDLE_WINDOW_SECS
  const secs = raw ? Number.parseInt(raw, 10) : DEFAULT_IDLE_WINDOW_SECS
  return (Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_IDLE_WINDOW_SECS) * 1000
}

/**
 * Cron-triggered work. Runs every 5 minutes (see wrangler.toml crons).
 *
 * GH#115 P1.7 §B-JANITOR-2: hard-deletes `worktrees` rows whose
 * `releasedAt` is older than the idle window. Re-attached rows
 * (releasedAt cleared by `reserveFreshWorktree` / `bindWorktreeById`
 * on the same reservedBy — see `apps/orchestrator/src/lib/reserve-worktree.ts`)
 * are left alone. Replaces the legacy `worktreeReservations`
 * stale-flag GC: post-migration 0027 the `worktreeReservations`
 * table no longer exists, and "staleness" is derived in the chain
 * projection (`ChainWorktreeReservation.stale = lastTouchedAt > 7d`)
 * rather than carried as a column.
 */
export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    const result = await runWorktreesJanitor(env)
    if (result.deletedCount > 0) {
      console.log(
        `[cron] worktrees-janitor deleted ${result.deletedCount} rows: ${result.deletedIds.join(
          ', ',
        )}`,
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[cron] worktrees-janitor failed: ${message}`)
  }
}

/**
 * Hard-delete worktrees whose grace window has expired. Returns
 * `{deletedCount, deletedIds}`. Exported so the admin sweep endpoint
 * (`POST /api/admin/worktrees/sweep`) can run the same logic
 * synchronously and surface the result to the operator.
 */
export async function runWorktreesJanitor(env: Env): Promise<{
  deletedCount: number
  deletedIds: string[]
}> {
  const db = drizzle(env.AUTH_DB, { schema })
  const cutoff = Date.now() - getIdleWindowMs(env)
  const deleted = await db
    .delete(worktrees)
    .where(and(isNotNull(worktrees.releasedAt), lt(worktrees.releasedAt, cutoff)))
    .returning({ id: worktrees.id })
  return {
    deletedCount: deleted.length,
    deletedIds: deleted.map((r) => r.id),
  }
}
