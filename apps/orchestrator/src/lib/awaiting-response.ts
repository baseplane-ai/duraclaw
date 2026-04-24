/**
 * awaiting-response — `AwaitingResponsePart` type + builder.
 *
 * Spec #80 P1: a trailing part on the user message that marks "we're
 * waiting on the runner but no events have arrived yet". Stamped by
 * SessionDO at every turn-entry point (sendMessage / spawn /
 * forkWithHistory / resubmitMessage) and cleared on the first runner
 * event. Surfaces via `useDerivedStatus` as the new `'pending'` status
 * and renders as a placeholder assistant bubble in ChatThread.
 *
 * Only `first_token` is wired in v1 — the other reasons are reserved
 * shape for future SDK features (subagent_started / Monitor tool /
 * async-wake resume) so they can land without a wire or DB migration.
 */

export type AwaitingReason =
  | 'first_token' // v1-wired: sendMessage → first runner event
  | 'subagent' // reserved (SDK subagent_started — not emitted today)
  | 'monitor' // reserved (Monitor tool — not yet in SDK)
  | 'async_wake' // reserved (async-wake resume — not yet in SDK)

export interface AwaitingResponsePart {
  type: 'awaiting_response'
  state: 'pending'
  reason: AwaitingReason
  startedTs: number
}

export function buildAwaitingPart(reason: AwaitingReason): AwaitingResponsePart {
  return {
    type: 'awaiting_response',
    state: 'pending',
    reason,
    startedTs: Date.now(),
  }
}
