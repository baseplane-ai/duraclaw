/**
 * resume-scheduler.ts — Account failover (GH#119 P3) + legacy CAAM
 * rotation hooks.
 *
 * Spec #101 B3a: ALL failover/rotation DO logic lives in this module
 * post-extraction. The facade's alarm handler calls `checkPendingResume`
 * (legacy CAAM scaffold) and `checkWaitingIdentity` (GH#119 P3 alarm-
 * loop poller). Rate-limit / auth-error events route through
 * `handleRateLimit(ctx, event, reason?)`.
 *
 * Public surface:
 *   - `checkPendingResume(ctx)` — legacy CAAM scaffold (no-op).
 *   - `handleRateLimit(ctx, event, reason?)` — GH#119 P3 failover entry.
 *     Marks the current identity as `cooldown`, picks the next via LRU,
 *     broadcasts a `FailoverEvent`, and triggers a resume dial. When no
 *     identity is available, flips the session to `waiting_identity`
 *     and arms the alarm to retry every 60s (capped at 30 ticks).
 *   - `checkWaitingIdentity(ctx)` — alarm-loop body. Re-queries D1 for
 *     an available identity, fires the resume + clears the counter on
 *     success, bumps + re-arms on miss, declares the session failed
 *     after 30 misses.
 */

import type { GatewayEvent } from '~/lib/types'
import { findAvailableIdentity, triggerGatewayDial } from './runner-link'
import { persistMetaPatch, updateState } from './status'
import type { SessionDOContext } from './types'

/** Max retry ticks the waiting_identity alarm-loop will run before giving up. ~30min @ 60s ticks. */
const WAITING_IDENTITY_MAX_RETRIES = 30
/** Alarm cadence for the waiting_identity poller. */
const WAITING_IDENTITY_TICK_MS = 60_000
/** Fallback cooldown when the runner did not stamp `resets_at` (or stamped a past time). */
const FALLBACK_COOLDOWN_MS = 30 * 60_000

/**
 * Check the `pendingResume` deadline persisted in DO SQLite kv. If
 * `Date.now()` has passed `pendingResume.at`, dispatch the deferred
 * resume command and clear the pending row.
 *
 * Called from the top of `runAlarm()` (watchdog.ts) before any stale-
 * session checks — a pending CAAM resume must fire even when the
 * session looks "idle" from the outside.
 *
 * No-op until CAAM ships.
 */
export async function checkPendingResume(_ctx: SessionDOContext): Promise<void> {
  // Legacy CAAM scaffold — unrelated to GH#119 P3 failover. Kept for
  // future profile-rotation work; today the failover path goes through
  // `handleRateLimit` + `checkWaitingIdentity` instead.
  return
}

/**
 * Resolve the cooldown timestamp for the rate-limited identity. Parses
 * `resets_at` (ISO string) when present and in the future; falls back
 * to `now + 30min` otherwise. Returned as an ISO string suitable for
 * direct write to `runner_identities.cooldown_until`.
 */
function resolveCooldownUntil(rateLimitInfo: Record<string, unknown>): string {
  const raw = rateLimitInfo.resets_at
  if (typeof raw === 'string') {
    const parsed = new Date(raw).getTime()
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      return new Date(parsed).toISOString()
    }
  }
  return new Date(Date.now() + FALLBACK_COOLDOWN_MS).toISOString()
}

/**
 * Look up the current session's identity row by joining `agent_sessions`
 * → `runner_identities` on `identity_name`. Returns `null` when no
 * identity is attached to the session (P2 zero-identities path) or the
 * named identity has been deleted by an admin.
 */
async function loadCurrentIdentity(
  ctx: SessionDOContext,
): Promise<{ id: string; name: string } | null> {
  try {
    const sessionRow = await ctx.env.AUTH_DB.prepare(
      `SELECT identity_name FROM agent_sessions WHERE id = ?`,
    )
      .bind(ctx.do.name)
      .first<{ identity_name: string | null }>()
    const name = sessionRow?.identity_name
    if (!name) return null
    const idRow = await ctx.env.AUTH_DB.prepare(
      `SELECT id, name FROM runner_identities WHERE name = ?`,
    )
      .bind(name)
      .first<{ id: string; name: string }>()
    return idRow ?? null
  } catch (err) {
    ctx.logEvent('warn', 'failover', 'loadCurrentIdentity failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Persist a `cooldown` mark on the rate-limited identity. Best-effort —
 * a D1 hiccup is logged and swallowed so the failover sequence still
 * fires (the LRU query will skip the identity even without an explicit
 * `status='cooldown'` once `cooldown_until` is set, but stamping both is
 * the canonical pattern P2 introduced).
 */
async function markIdentityCooldown(
  ctx: SessionDOContext,
  identityId: string,
  cooldownUntil: string,
): Promise<void> {
  try {
    // Normalise the ISO cooldown via SQLite's `datetime(?)` so the
    // stored value matches `datetime('now')` format (`YYYY-MM-DD
    // HH:MM:SS`). The LRU SELECT compares `cooldown_until <
    // datetime('now')`, and ISO format (`YYYY-MM-DDTHH:MM:SS.sssZ`)
    // is lexicographically greater at position 10 (`'T' > ' '`),
    // which would falsely keep an expired cooldown active.
    await ctx.env.AUTH_DB.prepare(
      `UPDATE runner_identities
         SET status = 'cooldown',
             cooldown_until = datetime(?),
             updated_at = datetime('now')
         WHERE id = ?`,
    )
      .bind(cooldownUntil, identityId)
      .run()
  } catch (err) {
    ctx.logEvent('warn', 'failover', 'markIdentityCooldown failed', {
      identityId,
      cooldownUntil,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Broadcast a `FailoverEvent` to connected browser clients so the
 * StatusBar can flash "Switching accounts..." and any per-session UI
 * surfaces can react. The DO's existing `gateway_event` envelope is
 * reused — clients already dispatch on the inner `event.type`.
 */
function broadcastFailover(
  ctx: SessionDOContext,
  fromIdentity: string,
  toIdentity: string,
  reason: 'rate_limit' | 'auth_error',
): void {
  try {
    ctx.broadcast(
      JSON.stringify({
        type: 'gateway_event',
        event: {
          type: 'failover',
          session_id: ctx.do.name,
          from_identity: fromIdentity,
          to_identity: toIdentity,
          reason,
        },
      }),
    )
  } catch (err) {
    ctx.logEvent('warn', 'failover', 'broadcastFailover failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Fire a resume dial to the gateway under whichever identity LRU picks
 * next. The caller has already cooled down the previous identity and
 * confirmed at least one available identity exists, so the LRU inside
 * `triggerGatewayDial` is expected to pick it up. `session_store_enabled`
 * is force-set to `true` so the new runner reads the transcript from
 * DO SQLite instead of the previous identity's local disk.
 */
async function dispatchFailoverResume(ctx: SessionDOContext): Promise<boolean> {
  const runnerSessionId = ctx.state.runner_session_id
  if (!runnerSessionId) {
    ctx.logEvent('warn', 'failover', 'cannot resume — runner_session_id missing')
    return false
  }
  const project = ctx.state.project
  if (!project) {
    ctx.logEvent('warn', 'failover', 'cannot resume — project missing')
    return false
  }
  try {
    await triggerGatewayDial(ctx, {
      type: 'resume',
      project,
      prompt: '',
      runner_session_id: runnerSessionId,
      session_store_enabled: true,
    })
    return true
  } catch (err) {
    ctx.logEvent('error', 'failover', 'triggerGatewayDial(resume) failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Handle a `rate_limit` GatewayEvent (or a synthesised auth-error
 * equivalent) from the runner. Implements the GH#119 B5 failover state
 * machine:
 *
 *   1. Cool down the current identity (cooldown_until from `resets_at`
 *      or +30min fallback).
 *   2. If another identity is available, broadcast a `FailoverEvent`,
 *      flip status to `failover`, and `triggerGatewayDial({type:'resume',
 *      session_store_enabled:true})`. The runner's `session.init` later
 *      flips status back to `running`.
 *   3. If no identity is available, flip to `waiting_identity` and arm
 *      the alarm-loop poller for 60s ticks.
 *
 * `reason` is forwarded to the broadcast event so the UI can distinguish
 * rate-limit from auth failures.
 *
 * Best-effort throughout: any D1 / WS error is logged and swallowed so
 * the DO never crashes on the failover path.
 */
export async function handleRateLimit(
  ctx: SessionDOContext,
  event: Extract<GatewayEvent, { type: 'rate_limit' }>,
  reason: 'rate_limit' | 'auth_error' = 'rate_limit',
): Promise<void> {
  const current = await loadCurrentIdentity(ctx)
  if (!current) {
    // Zero-identities path (P2): the session was spawned without an
    // identity, or the admin deleted the row. Nothing to fail over to —
    // the rate-limit text already lands as a normal failed turn via
    // the existing pipeline.
    ctx.logEvent('info', 'failover', 'no current identity attached — skipping failover')
    return
  }

  const cooldownUntil = resolveCooldownUntil(event.rate_limit_info)
  await markIdentityCooldown(ctx, current.id, cooldownUntil)
  ctx.logEvent('info', 'failover', `identity ${current.name} cooled down`, {
    identityId: current.id,
    cooldownUntil,
    reason,
  })

  const next = await findAvailableIdentityWithCatch(ctx)
  if (next) {
    broadcastFailover(ctx, current.name, next.name, reason)
    updateState(ctx, {
      status: 'failover',
      waiting_identity_retries: 0,
      error: null,
    })
    const ok = await dispatchFailoverResume(ctx)
    if (!ok) {
      // Resume dial failed for a structural reason (no runner_session_id
      // / project). Surface as terminal error since we cannot recover.
      updateState(ctx, {
        status: 'error',
        error: 'Failover resume failed — session not recoverable',
      })
    }
    return
  }

  // No identity available — enter the waiting_identity alarm loop.
  enterWaitingIdentity(ctx, 0)
}

/**
 * Wrapper around `findAvailableIdentity` that swallows D1 errors so the
 * caller can decide between "no identity" and "lookup failed" without
 * try/catch noise. Logs the underlying error.
 */
async function findAvailableIdentityWithCatch(
  ctx: SessionDOContext,
): Promise<{ id: string; name: string; home_path: string } | null> {
  try {
    return await findAvailableIdentity(ctx)
  } catch (err) {
    ctx.logEvent('warn', 'failover', 'findAvailableIdentity failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Flip the session into `waiting_identity` with the given retry count,
 * persist the counter, and arm the next alarm tick. Called from both
 * `handleRateLimit` (initial entry, retries=0) and `checkWaitingIdentity`
 * (subsequent ticks, retries>0).
 */
function enterWaitingIdentity(ctx: SessionDOContext, retries: number): void {
  updateState(ctx, {
    status: 'waiting_identity',
    waiting_identity_retries: retries,
    error: 'All identities on cooldown — retrying',
  })
  // updateState already mirrored the patch into session_meta via
  // persistMetaPatch, so the counter survives DO hibernation between
  // alarm ticks.
  try {
    ctx.ctx.storage.setAlarm(Date.now() + WAITING_IDENTITY_TICK_MS)
  } catch (err) {
    ctx.logEvent('warn', 'failover', 'setAlarm failed for waiting_identity', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Alarm-loop body called from `runAlarm`. Bails when the session is not
 * in `waiting_identity`. Re-queries D1; on success fires the resume +
 * clears the counter, on miss bumps + re-arms the alarm. Declares the
 * session failed after `WAITING_IDENTITY_MAX_RETRIES` consecutive misses.
 */
export async function checkWaitingIdentity(ctx: SessionDOContext): Promise<void> {
  if (ctx.state.status !== 'waiting_identity') return

  const retries = ctx.state.waiting_identity_retries ?? 0
  if (retries >= WAITING_IDENTITY_MAX_RETRIES) {
    ctx.logEvent('error', 'failover', 'waiting_identity exhausted — session failed', {
      retries,
    })
    updateState(ctx, {
      status: 'error',
      error: 'All identities exhausted after 30min',
      waiting_identity_retries: 0,
    })
    return
  }

  const next = await findAvailableIdentityWithCatch(ctx)
  if (!next) {
    const bumped = retries + 1
    ctx.logEvent('info', 'failover', `waiting_identity tick — no identity available (${bumped})`, {
      retries: bumped,
    })
    // Re-arm via persistMetaPatch + setAlarm without flipping status
    // (already waiting_identity). Avoid updateState's status-frame
    // broadcast so we don't spam clients with no-op transitions.
    persistMetaPatch(ctx, { waiting_identity_retries: bumped })
    ctx.do.setState({
      ...ctx.state,
      waiting_identity_retries: bumped,
    })
    try {
      ctx.ctx.storage.setAlarm(Date.now() + WAITING_IDENTITY_TICK_MS)
    } catch (err) {
      ctx.logEvent('warn', 'failover', 'setAlarm failed for waiting_identity tick', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  // Identity available — flip to failover and dial.
  const previous = await loadCurrentIdentity(ctx)
  broadcastFailover(ctx, previous?.name ?? 'unknown', next.name, 'rate_limit')
  updateState(ctx, {
    status: 'failover',
    waiting_identity_retries: 0,
    error: null,
  })
  const ok = await dispatchFailoverResume(ctx)
  if (!ok) {
    updateState(ctx, {
      status: 'error',
      error: 'Failover resume failed — session not recoverable',
    })
  }
}
