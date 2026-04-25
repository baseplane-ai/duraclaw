import type { Env } from '~/lib/types'

/**
 * Cron-triggered work. Runs every 5 minutes (see wrangler.toml crons).
 *
 * Previously also reconciled session rows against the gateway's
 * `GET /sessions` snapshot — that was redundant with the DO's own
 * `syncStatusToD1` / `syncResultToD1` / `syncSdkSessionIdToD1` writes
 * and caused a bulk-bump bug where dormant rows (snapshot
 * `last_activity_ts === null`) had their `last_activity` column
 * stamped to the cron tick time, scrambling sidebar ordering.
 * The gateway reconciliation is deleted; the DO is now the sole
 * writer of `agent_sessions.{status,last_activity,num_turns,…}`.
 */
export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    await runWorktreeStaleGc(env)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[cron] worktree-stale-gc failed: ${message}`)
  }

  // Batch-analysis lane (PR #6). No-ops cleanly when the lane isn't
  // configured (`ANTHROPIC_API_KEY` missing) so this runs harmlessly
  // on every deploy regardless of opt-in state.
  try {
    const { pollBatchJobs } = await import('../batch/cron-poller')
    const advanced = await pollBatchJobs({ env })
    if (advanced > 0) {
      console.log(`[cron] batch-lane: advanced ${advanced} job rows`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[cron] batch-lane poller failed: ${message}`)
  }
}

/**
 * Worktree-reservation stale-flag GC.
 *
 * Marks reservations whose `last_activity_at` is older than 7 days as
 * stale, and defensively clears the stale flag on rows that have since
 * seen activity (clock skew, webhook-driven recovery, etc.).
 *
 * See planning/specs/16-chain-ux.md → 3E/B14.
 */
async function runWorktreeStaleGc(env: Env): Promise<void> {
  await env.AUTH_DB.prepare(
    `UPDATE worktree_reservations
       SET stale = 1
     WHERE last_activity_at < datetime('now', '-7 days')
       AND stale = 0`,
  ).run()
  await env.AUTH_DB.prepare(
    `UPDATE worktree_reservations
       SET stale = 0
     WHERE last_activity_at >= datetime('now', '-7 days')
       AND stale = 1`,
  ).run()
}
