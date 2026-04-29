/**
 * GH#116 P2: DEPRECATED legacy shim.
 *
 * The old `tryAutoAdvance` dispatcher and the kata `runEnded` evidence
 * gate are gone. Auto-advance is now a two-step primitive:
 *   - `advanceArcGate(ctx, {terminateReason})` decides whether to fire
 *   - `advanceArcImpl(ctx, {mode, prompt})` mints the successor
 *
 * Both live in `~/agents/session-do/advance-arc.ts`. This module is
 * kept only to satisfy a handful of legacy imports until the P5
 * sweep:
 *   - `arc-status-item.tsx` imports `CORE_RUNG_ORDER` + `CoreRung`
 *     (UI rendering — preserved here verbatim).
 *   - The auto-advance unit tests still import `tryAutoAdvance` /
 *     `nextRung` / `CORE_RUNGS` (will be rewritten when mode-
 *     transition.ts is deleted).
 *
 * Delete this file in P5 once all callers have migrated.
 */

export { advanceArcGate, advanceArcImpl, nextMode } from '~/agents/session-do/advance-arc'

/**
 * The 5 "core" kata modes that form the linear advancement chain, in
 * ladder order. UI consumers (arc-status-item) render the ladder
 * from this. Pure-data export — no behavior here.
 */
export const CORE_RUNG_ORDER = [
  'research',
  'planning',
  'implementation',
  'verify',
  'close',
] as const

export type CoreRung = (typeof CORE_RUNG_ORDER)[number]

/** Set form of `CORE_RUNG_ORDER` for membership checks. */
export const CORE_RUNGS = new Set<string>(CORE_RUNG_ORDER)

/**
 * Legacy alias for `nextMode`. Retained until the test suite migrates.
 * Prefer `nextMode` from `~/agents/session-do/advance-arc` in new code.
 */
export { nextMode as nextRung } from '~/agents/session-do/advance-arc'

/**
 * @deprecated GH#116 P2: removed. Stub kept only so the legacy
 * `mode-transition.ts` (slated for deletion) and the `auto-advance.test.ts`
 * suite (slated for rewrite) typecheck during the rollout window. Calls
 * always return `{action:'none'}` — runtime callers must migrate to
 * `advanceArcGate` + `advanceArcImpl`.
 */
export type AutoAdvanceResult =
  | { action: 'none' }
  | { action: 'stalled'; reason: string }
  | { action: 'advanced'; newSessionId: string; nextMode: string }
  | { action: 'error'; error: string }

/** @deprecated see {@link AutoAdvanceResult}. */
export interface TryAutoAdvanceParams {
  sessionId: string
  userId: string
  kataIssue: number
  kataMode: string
  project: string
  runEnded: boolean
}

/** @deprecated see {@link AutoAdvanceResult}. */
export async function tryAutoAdvance(
  _env: unknown,
  _params: TryAutoAdvanceParams,
  _executionCtx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<AutoAdvanceResult> {
  return { action: 'none' }
}
