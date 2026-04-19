import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions } from '~/db/schema'
import type { Env } from '~/lib/types'

/**
 * Gateway session snapshot — thin shape returned by GET /sessions.
 * Contains live cost/status data but no project or prompt info.
 */
interface GatewaySessionSnapshot {
  session_id: string
  state: 'running' | 'completed' | 'failed' | 'aborted' | 'crashed'
  sdk_session_id: string | null
  last_activity_ts: number | null
  last_event_seq: number
  cost: { input_tokens: number; output_tokens: number; usd: number }
  model: string | null
  turn_count: number
}

/**
 * Cron-triggered sync. Runs every 5 minutes (see wrangler.toml crons).
 *
 * Fetches live session snapshots from the gateway GET /sessions endpoint
 * and updates matching D1 rows with fresh cost, status, model, and
 * turn data. Only updates existing rows (backfilled or spawned via
 * SessionDO) — does not insert new ones, since the gateway's thin
 * response lacks project/prompt info needed for a useful D1 row.
 *
 * On any failure (network, non-2xx, malformed JSON) logs a warning and
 * exits cleanly. No retry; the next 5-minute tick retries from scratch.
 */
export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // Piggyback the worktree-reservation stale GC onto every cron tick.
  // Cheap SQL + idempotent, so running every 5min (rather than hourly
  // as specced) is fine. Isolated in its own try/catch so a GC failure
  // never blocks the gateway-session sync below.
  try {
    await runWorktreeStaleGc(env)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[cron] worktree-stale-gc failed: ${message}`)
  }

  if (!env.CC_GATEWAY_URL) {
    console.warn('[cron] CC_GATEWAY_URL not configured — skipping sync')
    return
  }

  const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const sessionsUrl = new URL('/sessions', httpBase)
  const headers: Record<string, string> = {}
  if (env.CC_GATEWAY_SECRET) {
    headers.Authorization = `Bearer ${env.CC_GATEWAY_SECRET}`
  }

  let snapshots: GatewaySessionSnapshot[]
  try {
    const resp = await fetch(sessionsUrl.toString(), {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      console.warn(`[cron] gateway unreachable: status=${resp.status}`)
      return
    }
    const data = (await resp.json()) as { ok?: boolean; sessions?: unknown }
    if (!data || !Array.isArray(data.sessions)) {
      console.warn(`[cron] invalid response shape`)
      return
    }
    snapshots = data.sessions as GatewaySessionSnapshot[]
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[cron] gateway unreachable: ${message}`)
    return
  }

  if (snapshots.length === 0) {
    return
  }

  const db = drizzle(env.AUTH_DB, { schema })
  const now = new Date().toISOString()

  // Map gateway state to D1 status
  const mapStatus = (state: GatewaySessionSnapshot['state']): string => {
    switch (state) {
      case 'running':
        return 'running'
      case 'completed':
        return 'idle'
      case 'failed':
      case 'aborted':
      case 'crashed':
        return 'idle'
      default:
        return 'idle'
    }
  }

  let updated = 0
  await db.transaction(async (tx) => {
    for (const s of snapshots) {
      if (!s.sdk_session_id) continue
      try {
        const lastActivity = s.last_activity_ts ? new Date(s.last_activity_ts).toISOString() : now

        await tx
          .update(agentSessions)
          .set({
            status: mapStatus(s.state),
            model: s.model ?? undefined,
            updatedAt: now,
            lastActivity: lastActivity,
            numTurns: s.turn_count || undefined,
            totalCostUsd: s.cost.usd || undefined,
          })
          .where(eq(agentSessions.sdkSessionId, s.sdk_session_id))

        updated++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[cron] update failed for ${s.sdk_session_id}: ${message}`)
      }
    }
  })

  console.log(`[cron] synced ${updated}/${snapshots.length} gateway sessions`)
}

/**
 * Worktree-reservation stale-flag GC.
 *
 * Marks reservations whose `last_activity_at` is older than 7 days as
 * stale, and defensively clears the stale flag on rows that have since
 * seen activity (clock skew, webhook-driven recovery, etc.).
 *
 * Runs every cron tick (currently every 5min) — SQL is cheap and
 * idempotent, so it's fine to run more often than the hourly cadence
 * described in the spec. See planning/specs/16-chain-ux.md → 3E/B14.
 */
async function runWorktreeStaleGc(env: Env): Promise<void> {
  // Mark newly-stale rows.
  await env.AUTH_DB.prepare(
    `UPDATE worktree_reservations
       SET stale = 1
     WHERE last_activity_at < datetime('now', '-7 days')
       AND stale = 0`,
  ).run()
  // Clear stale on recently-active rows.
  await env.AUTH_DB.prepare(
    `UPDATE worktree_reservations
       SET stale = 0
     WHERE last_activity_at >= datetime('now', '-7 days')
       AND stale = 1`,
  ).run()
}
