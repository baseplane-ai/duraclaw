/**
 * resume-scheduler.ts — CAAM (Claude Account Auto-rotation Manager)
 * rotation logic.
 *
 * Spec #101 B3a: ALL CAAM-related DO logic lives in this module post-
 * extraction. The facade's alarm handler calls `checkPendingResume(ctx)`
 * for the delayed-resume dispatch; rate_limit events route through
 * `handleRateLimit(ctx, event)`. No CAAM logic remains in `index.ts`.
 *
 * Status: Stage 3 scaffold. The CAAM rotation feature itself (spec #92)
 * has not landed yet — there is currently no `planRateLimitAction()`,
 * no `pendingResume` persistence, no `waiting_profile` status, and no
 * rotation breadcrumb insertion in the codebase. This module exists so
 * that when CAAM ships, ALL of its DO-side logic lands here in one
 * place rather than re-litigating placement in another spec.
 *
 * Public surface (current):
 *   - `checkPendingResume(ctx)` — alarm-driven delayed-resume probe.
 *     Currently a no-op; future: read `pendingResume` row from
 *     SQLite kv, compare to `Date.now()`, fire `triggerGatewayDial`
 *     with a `resume` command if the deadline has passed.
 *   - `handleRateLimit(ctx, event)` — rate_limit GatewayEvent handler.
 *     Currently a no-op; future: call `planRateLimitAction()` (from
 *     `~/lib/caam-rotation`), persist `pendingResume`, insert a
 *     system breadcrumb (`<<system: rotation pending>>`), flip status
 *     to `waiting_profile`.
 *
 * When the CAAM feature lands, the import for `planRateLimitAction`
 * goes here (NOT in `index.ts`). Same for the `pendingResume` /
 * `waiting_profile` types — they live in `./types.ts`.
 */

import type { GatewayEvent } from '~/lib/types'
import type { SessionDOContext } from './types'

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
  // CAAM not yet implemented. Future:
  //   1. Read `pendingResume` row from `ctx.sql`.
  //   2. If row.at <= Date.now(), call `ctx.do.triggerGatewayDial({type: 'resume', ...})`.
  //   3. Delete the row.
  //   4. Insert system breadcrumb message via `ctx.do.safeAppendMessage`.
  return
}

/**
 * Handle a `rate_limit` GatewayEvent emitted by the runner. Currently
 * the DO has no special handling — the rate-limit text flows through
 * the normal assistant-message persistence path. When CAAM ships,
 * this function will:
 *
 *   1. Call `planRateLimitAction(event)` (from `~/lib/caam-rotation`)
 *      to decide between rotate-now / wait-and-resume / surface-to-user.
 *   2. If wait-and-resume, persist a `pendingResume` row with the
 *      computed deadline; flip session status to `waiting_profile`.
 *   3. Insert a system breadcrumb message
 *      (`<<system: rotation pending — resuming at HH:MM>>`).
 *   4. Schedule the next alarm at the resume deadline so the watchdog
 *      wakes the DO on time.
 */
export async function handleRateLimit(
  _ctx: SessionDOContext,
  _event: Extract<GatewayEvent, { type: 'rate_limit' }>,
): Promise<void> {
  // CAAM not yet implemented. The current DO surfaces rate_limit text
  // through the normal assistant-message persistence path; this stub
  // exists so the call site in handleGatewayEvent (Stage 4 work) can
  // already point here.
  return
}
