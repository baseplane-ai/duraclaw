import type { SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import {
  broadcastMessages as broadcastMessagesImpl,
  broadcastToClients as broadcastToClientsImpl,
} from './broadcast'
import { safeUpdateMessage as safeUpdateMessageImpl } from './history'
import { hydrateFromGatewayImpl } from './hydrate-from-gateway'
import { maybeReleaseWorktreeOnTerminal } from './maybe-release-worktree'
import { finalizeStreamingParts } from './message-parts'
import { sendToGateway } from './runner-link'
import { AWAITING_LIVE_CONN_GRACE_MS, RECOVERY_GRACE_MS, type SessionDOContext } from './types'
import {
  clearRecoveryGraceTimer as clearRecoveryGraceTimerImpl,
  planAwaitingTimeout,
  planClearAwaiting,
} from './watchdog'

export function clearAwaitingResponseImpl(ctx: SessionDOContext): void {
  const plan = planClearAwaiting(ctx.session.getHistory())
  if (plan === null) return
  safeUpdateMessageImpl(ctx, plan.updated)
  broadcastMessagesImpl(ctx, [plan.updated as unknown as WireSessionMessage])
}

/**
 * Spec #101 Stage 6: extracted bodies for `SessionDO.checkAwaitingTimeout()`,
 * `SessionDO.failAwaitingTurn(...)`, `SessionDO.recoverFromDroppedConnection()`,
 * and `SessionDO.fireRunawayInterrupt(...)`. All four orbit the
 * "awaiting → terminal" lifecycle, so they live in one module.
 */

export async function checkAwaitingTimeoutImpl(ctx: SessionDOContext): Promise<void> {
  const decision = planAwaitingTimeout({
    history: ctx.session.getHistory(),
    connectionId: ctx.do.getGatewayConnectionId(),
    now: Date.now(),
    graceMs: RECOVERY_GRACE_MS,
    extendedGraceMs: AWAITING_LIVE_CONN_GRACE_MS,
  })
  if (decision.kind === 'noop') return

  if (decision.reason === 'connection-lost') {
    // Gateway WS is gone — full recovery (transition to error, drop token).
    await failAwaitingTurnImpl(ctx, 'runner failed to attach within recovery grace')
    return
  }

  // Gateway WS alive but stream-input silently dropped on the wire.
  // Soft-recover: clear the awaiting part + append a notice prompting the
  // user to retry, but KEEP the session running and the runner attached.
  await failAwaitingTurnSilentDropImpl(ctx)
}

/**
 * Soft-recovery for the silent-drop case: the runner WS still appears
 * healthy (it's processing other turns fine) but THIS user message's
 * stream-input never arrived. Clear the awaiting part, append a system
 * notice, and leave the session running so the user can simply retry.
 *
 * Differs from `failAwaitingTurnImpl` in two important ways:
 *   1. State stays whatever it currently is (NOT flipped to 'error').
 *   2. `active_callback_token` is preserved — the runner is fine, the
 *      drop was a single-message wire-level loss.
 */
export async function failAwaitingTurnSilentDropImpl(ctx: SessionDOContext): Promise<void> {
  ctx.do.clearAwaitingResponse()

  ctx.do.turnCounter++
  const errorMsgId = `err-${ctx.do.turnCounter}`
  const errorMsg: SessionMessage = {
    id: errorMsgId,
    role: 'system',
    parts: [
      {
        type: 'text',
        text: '⚠ Your last message did not reach the runner (silent network drop). Please send it again — the session is still running.',
      },
    ],
    createdAt: new Date(),
  }
  try {
    await ctx.do.safeAppendMessage(errorMsg)
    broadcastMessagesImpl(ctx, [errorMsg as unknown as WireSessionMessage])
  } catch (err) {
    console.error(
      `[SessionDO:${ctx.ctx.id}] silent-drop recovery: failed to append notice row:`,
      err,
    )
  }
}

export async function failAwaitingTurnImpl(
  ctx: SessionDOContext,
  errorText: string,
): Promise<void> {
  ctx.do.clearAwaitingResponse()

  // Persist the error as a visible system message row — mirrors the
  // `case 'error':` path in handleGatewayEvent so the UI has a concrete
  // row to render alongside the status flip.
  ctx.do.turnCounter++
  const errorMsgId = `err-${ctx.do.turnCounter}`
  const errorMsg: SessionMessage = {
    id: errorMsgId,
    role: 'system',
    parts: [{ type: 'text', text: `⚠ Error: ${errorText}` }],
    createdAt: new Date(),
  }
  await ctx.do.safeAppendMessage(errorMsg)
  broadcastMessagesImpl(ctx, [errorMsg as unknown as WireSessionMessage])

  // Transition to `'error'` with the error text populated — spec #80
  // B7 widens `SessionStatus` to include `'error'` so the watchdog's
  // terminal state renders as a distinct UI badge (red). The system
  // message row above provides the diagnostic detail; the session
  // remains resumable via runner_session_id.
  ctx.do.updateState({
    status: 'error',
    error: errorText,
    active_callback_token: undefined,
  })
}

export async function recoverFromDroppedConnectionImpl(ctx: SessionDOContext): Promise<void> {
  // GH#57: clear any pending grace timer — we're running recovery now.
  clearRecoveryGraceTimerImpl(ctx)

  // Sync any missed messages from the gateway transcript
  try {
    await hydrateFromGatewayImpl(ctx)
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Recovery hydration failed:`, err)
  }

  // Finalize any streaming parts
  if (ctx.do.currentTurnMessageId) {
    const existing = ctx.session.getMessage(ctx.do.currentTurnMessageId)
    if (existing) {
      const finalizedParts = finalizeStreamingParts(existing.parts)
      ctx.do.safeUpdateMessage({ ...existing, parts: finalizedParts })
      broadcastMessagesImpl(ctx, [
        { ...existing, parts: finalizedParts } as unknown as WireSessionMessage,
      ])
    }
    ctx.do.currentTurnMessageId = null
    ctx.do.persistTurnState()
  }

  // If the runner crashed before producing a partial_assistant (e.g. SDK
  // boot failure before WS dial-back), no `clearAwaitingResponse` ever
  // ran, the tail of history is still the awaiting user turn, and
  // `findAwaitingReason` (in ChatThread) pins "Claude is thinking…"
  // forever — the gate is "tail is a user row", not "awaiting part
  // present", so just stripping the part is not enough. Strip the part
  // AND append a system row so the tail flips and the bubble closes.
  // Idempotent: planClearAwaiting returns null on the second pass.
  const awaitingPlan = planClearAwaiting(ctx.session.getHistory())
  if (awaitingPlan !== null) {
    safeUpdateMessageImpl(ctx, awaitingPlan.updated)
    broadcastMessagesImpl(ctx, [awaitingPlan.updated as unknown as WireSessionMessage])

    ctx.do.turnCounter++
    const noticeMsgId = `err-${ctx.do.turnCounter}`
    const noticeMsg: SessionMessage = {
      id: noticeMsgId,
      role: 'system',
      parts: [
        {
          type: 'text',
          text: '⚠ Runner did not respond — connection lost before any reply. Send a message to retry.',
        },
      ],
      createdAt: new Date(),
    }
    try {
      await ctx.do.safeAppendMessage(noticeMsg)
      broadcastMessagesImpl(ctx, [noticeMsg as unknown as WireSessionMessage])
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] Recovery: failed to append notice row:`, err)
    }
  }

  // Transition to idle (session may be resumable via runner_session_id).
  // Clear active_callback_token — the runner that owned it is gone.
  ctx.do.updateState({
    status: 'idle',
    error: 'Gateway connection lost — session stopped. You can send a new message to resume.',
    active_callback_token: undefined,
  })

  // GH#115 §B-LIFECYCLE-2: terminal-transition release-on-close.
  maybeReleaseWorktreeOnTerminal(ctx)

  // Notify connected clients
  broadcastToClientsImpl(
    ctx,
    JSON.stringify({
      type: 'gateway_event',
      event: { type: 'result', is_error: false, result: 'Connection lost — session idle' },
    }),
  )

  console.log(`[SessionDO:${ctx.ctx.id}] Recovery: transitioned to idle`)
}

/**
 * Shared fire path for both runaway-loop guards (empty-turn +
 * repeated-content). Sends the interrupt GatewayCommand, appends a
 * visible system error to the transcript, flips the session to idle
 * with the supplied error code, and clears both guard rings. Caller
 * `break`s out of the `case 'assistant'` after invoking.
 */
export function fireRunawayInterruptImpl(
  ctx: SessionDOContext,
  errorCode: string,
  userVisibleMessage: string,
  diagnostics: { kind: 'empty' | 'repeated'; consecutive: number },
): void {
  console.warn(`[session-do] runaway ${diagnostics.kind}-assistant-turn loop detected`, {
    sessionId: ctx.state.session_id,
    consecutive: diagnostics.consecutive,
  })
  sendToGateway(ctx, {
    type: 'interrupt',
    session_id: ctx.state.session_id ?? '',
  })
  ctx.do.turnCounter++
  const errorMsgId = `err-${ctx.do.turnCounter}`
  const errorMsg: SessionMessage = {
    id: errorMsgId,
    role: 'system',
    parts: [{ type: 'text', text: userVisibleMessage }],
    createdAt: new Date(),
  }
  try {
    ctx.do.safeAppendMessage(errorMsg)
    broadcastMessagesImpl(ctx, [errorMsg as unknown as WireSessionMessage])
  } catch (err) {
    console.error('[session-do] runaway-guard persist failed', err)
  }
  ctx.do.updateState({ status: 'idle', error: errorCode })
  ctx.do.consecutiveEmptyAssistantTurns = 0
  ctx.do.recentTurnFingerprints = []
  ctx.do.currentTurnMessageId = null
  ctx.do.persistTurnState()
  // GH#115 §B-LIFECYCLE-2: terminal-transition release-on-close.
  maybeReleaseWorktreeOnTerminal(ctx)
}
