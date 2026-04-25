/**
 * watchdog.ts — DO alarm body + recovery-grace timer plumbing.
 *
 * Spec #101 Stage 3 + Stage 6. The DO `alarm()` lifecycle method delegates
 * here via a thin dispatcher. This module owns:
 *
 *   - `runAlarm(ctx)` — full alarm body. Sequence:
 *       1. CAAM `pendingResume` check (delegated to resume-scheduler).
 *       2. Recovery-grace deadline expiry (durable kv backstop for the
 *          15s window in `maybeRecoverAfterGatewayDrop`).
 *       3. Stale-session detection (`resolveStaleThresholdMs`).
 *       4. Awaiting-response timeout (#80 B7 — independent of stale).
 *       5. Self-reschedule for the next 30s tick.
 *   - `scheduleWatchdog(ctx)` — set the next durable alarm.
 *   - `clearRecoveryGraceTimer(ctx)` — cancel the in-memory setTimeout
 *     and delete the durable `recovery_grace_until` kv row.
 *   - `resolveStaleThresholdMs`, `DEFAULT_STALE_THRESHOLD_MS`,
 *     `planAwaitingTimeout`, `planClearAwaiting` — pure helpers absorbed
 *     from the now-deleted `session-do-helpers.ts`.
 */

import type { SessionMessage } from 'agents/experimental/memory/session'
import { checkPendingResume } from './resume-scheduler'
import { ALARM_INTERVAL_MS, RECOVERY_GRACE_MS, type SessionDOContext } from './types'

/** Default stale threshold for the DO watchdog (ms). */
export const DEFAULT_STALE_THRESHOLD_MS = 90_000

/**
 * Resolve the stale-threshold used by the DO watchdog alarm. Reads from
 * env.STALE_THRESHOLD_MS when present and parsable as a positive integer;
 * otherwise falls back to {@link DEFAULT_STALE_THRESHOLD_MS}.
 */
export function resolveStaleThresholdMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_STALE_THRESHOLD_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALE_THRESHOLD_MS
  return n
}

/**
 * Pure version of `SessionDO.clearAwaitingResponse` (#80 B5).
 *
 * Scans history tail-first for the most-recent user message. If that
 * message's trailing part is `awaiting_response@pending`, returns a new
 * message value with that part stripped. Idempotent — returns `null`
 * when the tail user has no such part (already cleared or never
 * stamped), or when no user message exists in history.
 */
export function planClearAwaiting<TMsg extends SessionMessage>(
  history: readonly TMsg[],
): { updated: TMsg } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    if (msg.role !== 'user') continue
    const lastPart = msg.parts[msg.parts.length - 1] as
      | { type?: string; state?: string }
      | undefined
    if (lastPart?.type === 'awaiting_response' && lastPart.state === 'pending') {
      const nextParts = msg.parts.slice(0, -1)
      return { updated: { ...msg, parts: nextParts } }
    }
    // Tail user examined (awaiting present or not) — stop scanning.
    return null
  }
  return null
}

/**
 * Pure decision returned by {@link planAwaitingTimeout}.
 *
 * - `{ kind: 'noop' }` — nothing to do (no awaiting tail, runner
 *   attached, or the grace window has not elapsed).
 * - `{ kind: 'expire', startedTs }` — the caller should run the
 *   expire sequence: clear awaiting, append an error system message,
 *   flip DO state to `idle` with the error text populated, and sync
 *   status to D1.
 */
export type AwaitingTimeoutDecision = { kind: 'noop' } | { kind: 'expire'; startedTs: number }

/**
 * Pure version of `SessionDO.checkAwaitingTimeout` (#80 B7).
 *
 * Decides whether the watchdog should expire an awaiting_response part.
 * The decision is a pure function of the current history tail, the
 * runner connection id, the current clock, and the grace window; the
 * caller performs the state mutations so the side-effecting pieces
 * (safeAppendMessage / updateState) stay in the DO.
 */
export function planAwaitingTimeout<TMsg extends SessionMessage>(input: {
  history: readonly TMsg[]
  connectionId: string | null
  now: number
  graceMs?: number
}): AwaitingTimeoutDecision {
  if (input.connectionId !== null) return { kind: 'noop' }
  const grace = input.graceMs ?? RECOVERY_GRACE_MS

  for (let i = input.history.length - 1; i >= 0; i--) {
    const msg = input.history[i]
    if (msg.role !== 'user') continue
    const lastPart = msg.parts[msg.parts.length - 1] as
      | { type?: string; state?: string; startedTs?: number }
      | undefined
    if (lastPart?.type !== 'awaiting_response' || lastPart.state !== 'pending') {
      return { kind: 'noop' }
    }
    const startedTs = typeof lastPart.startedTs === 'number' ? lastPart.startedTs : 0
    if (input.now - startedTs <= grace) return { kind: 'noop' }
    return { kind: 'expire', startedTs }
  }
  return { kind: 'noop' }
}

/**
 * Schedule the next watchdog alarm at `ALARM_INTERVAL_MS` from now.
 * Alarms survive DO hibernation, unlike `setInterval` / `setTimeout`.
 */
export function scheduleWatchdog(ctx: SessionDOContext): void {
  ctx.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
}

/**
 * GH#57: cancel any pending recovery grace (runner reconnected, or
 * recovery is running through another path). Clears both the in-memory
 * `setTimeout` and the durable `kv` deadline consulted by `runAlarm`
 * after hibernation.
 */
export function clearRecoveryGraceTimer(ctx: SessionDOContext): void {
  if (ctx.do.recoveryGraceTimer !== null) {
    clearTimeout(ctx.do.recoveryGraceTimer)
    ctx.do.recoveryGraceTimer = null
  }
  try {
    ctx.sql.exec(`DELETE FROM kv WHERE key = 'recovery_grace_until'`)
  } catch {
    // ignore — kv table may not exist on pre-migration DO instances
  }
}

/**
 * DO alarm body — watchdog for stale gateway connections + CAAM
 * pendingResume dispatch. Self-reschedules at the end so the next tick
 * fires `ALARM_INTERVAL_MS` from now.
 *
 * Fires periodically while a runner is expected to be attached. The
 * guard checks both explicit in-flight status AND the presence of an
 * `active_callback_token` (set when a runner is spawned, cleared only
 * on recovery or terminal transition). This catches the "idle-between-
 * turns" case: after a `result` event, status flips to `idle` but the
 * runner stays alive waiting on `stream-input`. If the runner then
 * dies silently, the old status-only guard would skip the alarm and
 * status would stay `idle` forever — the DO would never notice the
 * runner is gone.
 */
export async function runAlarm(ctx: SessionDOContext): Promise<void> {
  // CAAM pendingResume check runs FIRST — a deferred resume must fire
  // even when the session otherwise looks idle (no runner, no awaiting
  // part). Spec #101 B3a.
  await checkPendingResume(ctx)

  const isActiveStatus =
    ctx.state.status === 'running' ||
    ctx.state.status === 'waiting_gate' ||
    ctx.state.status === 'pending'
  const hasRunner = !!ctx.state.active_callback_token
  if (!isActiveStatus && !hasRunner) {
    return // Truly idle — no runner expected, nothing to watch
  }

  const gwConnId = ctx.do.getGatewayConnectionId()

  // Hibernation-safe grace expiry: the in-memory setTimeout in
  // maybeRecoverAfterGatewayDrop is lost if the DO hibernates during
  // the grace window. The alarm is durable, so check the persisted
  // deadline here and run recovery if it has passed and no runner has
  // reconnected.
  try {
    const graceRows = ctx.sql
      .exec<{ value: string }>(`SELECT value FROM kv WHERE key = 'recovery_grace_until'`)
      .toArray()
    const graceUntilRaw = graceRows[0]?.value
    if (graceUntilRaw !== undefined) {
      const graceUntil = Number(graceUntilRaw)
      if (Number.isFinite(graceUntil) && Date.now() >= graceUntil) {
        ctx.sql.exec(`DELETE FROM kv WHERE key = 'recovery_grace_until'`)
        if (!gwConnId) {
          console.log(
            `[SessionDO:${ctx.ctx.id}] Watchdog: recovery grace expired (deadline=${graceUntil}) — running recovery`,
          )
          await ctx.do.recoverFromDroppedConnection()
          return
        }
        console.log(
          `[SessionDO:${ctx.ctx.id}] Watchdog: recovery grace expired but runner reconnected — clearing marker`,
        )
      }
    }
  } catch (err) {
    console.warn(`[SessionDO:${ctx.ctx.id}] Watchdog: recovery_grace read failed:`, err)
  }

  const staleDuration = Date.now() - ctx.do.lastGatewayActivity
  const staleThreshold = resolveStaleThresholdMs(ctx.env.STALE_THRESHOLD_MS)

  if (staleDuration > staleThreshold && !gwConnId) {
    console.log(
      `[SessionDO:${ctx.ctx.id}] Watchdog: stale for ${Math.round(staleDuration / 1000)}s with no gateway connection — recovering (threshold=${staleThreshold}ms)`,
    )
    await ctx.do.recoverFromDroppedConnection()
    return
  }

  // Spec #80 B7: independent predicate — a session with an active
  // awaiting part is not stale (last_activity was just bumped by the
  // user turn), so this must run outside the stale-session branch.
  await ctx.do.checkAwaitingTimeout()

  // Still active, schedule next check
  scheduleWatchdog(ctx)
}
