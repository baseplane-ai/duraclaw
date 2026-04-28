import type { WireMessagePart, SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'
import { eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import { generateActionToken } from '~/lib/action-token'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import { releaseWorktreeOnClose } from '~/lib/release-worktree-on-close'
import type { GatewayEvent } from '~/lib/types'
import { broadcastMessages as broadcastMessagesImpl } from './broadcast'
import { promoteToolPartToGate as promoteToolPartToGateImpl } from './gates'
import {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  fingerprintAssistantContent,
  isAssistantContentEmpty,
  mergeFinalAssistantParts,
  partialAssistantToParts,
} from './message-parts'
import { handleRateLimit } from './resume-scheduler'
import {
  syncCapabilitiesToD1 as syncCapabilitiesToD1Impl,
  syncKataAllToD1 as syncKataAllToD1Impl,
  syncResultToD1 as syncResultToD1Impl,
  syncRunnerSessionIdToD1 as syncRunnerSessionIdToD1Impl,
} from './status'
import { handleTitleUpdate } from './title'
import {
  REPEATED_TURN_THRESHOLD,
  RUNAWAY_EMPTY_TURN_THRESHOLD,
  type SessionDOContext,
} from './types'

/**
 * Map WireMessagePart → SessionMessagePart (identity today).
 * The indirection allows the wire type to diverge from the SDK type.
 */
function wireToSessionParts(wire: WireMessagePart[]): SessionMessagePart[] {
  return wire as unknown as SessionMessagePart[]
}

/**
 * GH#115 §B-LIFECYCLE-2 helper: on a true terminal transition
 * (`stopped` / `error`), if this session has a `worktreeId`, run the
 * last-session check and flip the worktree row to `cleanup`. Wrapped
 * in `ctx.ctx.waitUntil` + try/catch so a release failure never
 * crashes the close path — the cron janitor in
 * `apps/orchestrator/src/api/scheduled.ts` is the always-on safety net.
 *
 * Note: `case 'result'` is intentionally NOT a release trigger — that
 * event is a turn-complete signal, the runner stays alive awaiting the
 * next stream-input, and `active_callback_token` is preserved (see
 * comments at the `updateStateIdle` callback in the result handler).
 */
function maybeReleaseWorktreeOnTerminal(ctx: SessionDOContext): void {
  const worktreeId = ctx.state.worktreeId
  if (!worktreeId) return
  const sessionId = ctx.do.name
  ctx.ctx.waitUntil(
    releaseWorktreeOnClose(ctx.do.d1, sessionId, worktreeId).catch((err) => {
      console.error(
        `[SessionDO:${ctx.ctx.id}] release-on-close (worktreeId=${worktreeId}) failed:`,
        err,
      )
    }),
  )
}

/**
 * Spec #101 Stage 5 — gateway-event dispatch extracted from
 * SessionDO.handleGatewayEvent. Receives a `GatewayEvent` from the
 * runner WS and dispatches to the appropriate side-effect modules.
 *
 * No behavior change vs the inline class method — same WS frames, same
 * persistence order, same side-effects per event type.
 */
export function handleGatewayEvent(ctx: SessionDOContext, event: GatewayEvent): void {
  const self = ctx.do
  switch (event.type) {
    // GH#75 B4: relay BufferedChannel gap sentinel from the runner →
    // DO → client. The runner stamps `{type:'gap', dropped_count,
    // from_seq, to_seq}` on its WS when the pre-reattach buffer
    // overflowed; on the client we treat this as a synthetic gap
    // trigger and fire requestSnapshot. We don't try to reconcile the
    // sentinel's runner-seq range — runner.seq and DO.messageSeq are
    // different namespaces and the snapshot is the only safe
    // rehydration.
    case 'gap':
      ctx.broadcast(
        JSON.stringify({
          type: 'gap',
          dropped_count: (event as { dropped_count?: number }).dropped_count ?? 0,
          from_seq: (event as { from_seq?: number }).from_seq ?? 0,
          to_seq: (event as { to_seq?: number }).to_seq ?? 0,
        }),
      )
      break

    case 'session.init': {
      // Spec #101 P1.2 B7: relay AdapterCapabilities reported by the
      // runner. `capabilities` is optional on the wire — older runners
      // omit it; we leave the cached field at whatever it was (typically
      // null). When present we persist + broadcast a single SessionMeta
      // patch so downstream consumers see the runner_session_id, model,
      // and capabilities flip atomically.
      const patch: Partial<{
        runner_session_id: string | null
        model: string | null
        capabilities: typeof event.capabilities | null
      }> = {
        runner_session_id: event.runner_session_id,
        model: event.model,
      }
      if (event.capabilities !== undefined) {
        patch.capabilities = event.capabilities
      }
      self.updateState(patch)
      // Sync runner_session_id to D1 so discovery won't create a duplicate row.
      if (event.runner_session_id) {
        void syncRunnerSessionIdToD1Impl(ctx, event.runner_session_id, new Date().toISOString())
      }
      // Sync capabilities to D1 (and broadcast row update) so the
      // sidebar / agent-detail surfaces can render capability-aware UI
      // without a DO round-trip.
      if (event.capabilities !== undefined) {
        void syncCapabilitiesToD1Impl(ctx, event.capabilities, new Date().toISOString())
      }
      break
    }

    case 'partial_assistant': {
      self.clearAwaitingResponse()
      const parts = event.parts
        ? wireToSessionParts(event.parts)
        : partialAssistantToParts(event.content)
      const msgId = `msg-${self.turnCounter}`

      if (!self.currentTurnMessageId) {
        self.currentTurnMessageId = msgId

        // Check if message already exists (multi-response turn: assistant → tool → assistant)
        const existing = ctx.session.getMessage(msgId)
        if (existing) {
          // Merge streaming text / reasoning into existing parts (preserving tool results)
          const updatedParts = [...existing.parts]
          for (const newPart of parts) {
            if (newPart.type === 'text' || newPart.type === 'reasoning') {
              updatedParts.push(newPart)
            }
          }
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            self.safeUpdateMessage(updatedMsg)
            broadcastMessagesImpl(ctx, [updatedMsg as unknown as WireSessionMessage])
          } catch (err) {
            console.error('[session-do] event persist failed', err)
          }
        } else {
          // First partial of this turn — append new message. Parent defaults
          // to latestLeafRow() (the user row just persisted in sendMessage),
          // whose id may be `usr-N` OR `usr-client-<uuid>` depending on
          // whether the client supplied a `client_message_id` (GH#14 B6).
          // Passing an explicit `usr-${turnCounter}` used to silently land
          // parent_id=NULL when the user row was keyed on the client id —
          // orphaning every assistant and collapsing getHistory() to one row.
          const msg: SessionMessage = {
            id: msgId,
            role: 'assistant',
            parts,
            createdAt: new Date(),
          }
          try {
            self.safeAppendMessage(msg)
            self.persistTurnState()
            broadcastMessagesImpl(ctx, [msg as unknown as WireSessionMessage])
          } catch (err) {
            console.error('[session-do] event persist failed', err)
          }
        }
      } else {
        // Subsequent partial — update existing message with accumulated text
        const existing = ctx.session.getMessage(self.currentTurnMessageId)
        if (existing) {
          // Merge streaming parts: find an existing streaming text / reasoning
          // part of the same kind and append the delta. This drives live
          // token-by-token rendering for both the assistant text and the
          // extended-thinking trace.
          const updatedParts = [...existing.parts]
          for (const newPart of parts) {
            if (newPart.type === 'text') {
              const existingIdx = updatedParts.findIndex(
                (p) => p.type === 'text' && p.state === 'streaming',
              )
              if (existingIdx !== -1) {
                updatedParts[existingIdx] = {
                  ...updatedParts[existingIdx],
                  text: (updatedParts[existingIdx].text ?? '') + (newPart.text ?? ''),
                }
              } else {
                updatedParts.push(newPart)
              }
            } else if (newPart.type === 'reasoning') {
              const existingIdx = updatedParts.findIndex(
                (p) => p.type === 'reasoning' && p.state === 'streaming',
              )
              if (existingIdx !== -1) {
                updatedParts[existingIdx] = {
                  ...updatedParts[existingIdx],
                  text: (updatedParts[existingIdx].text ?? '') + (newPart.text ?? ''),
                }
              } else {
                updatedParts.push(newPart)
              }
            }
          }
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            self.safeUpdateMessage(updatedMsg)
            broadcastMessagesImpl(ctx, [updatedMsg as unknown as WireSessionMessage])
          } catch (err) {
            console.error('[session-do] event persist failed', err)
          }
        }
      }
      break
    }

    case 'assistant': {
      self.clearAwaitingResponse()

      // Runaway-turn guard: detect the "empty assistant loop" failure mode
      // (prod incident 2026-04-24 — 500+ single-ZWS turns). The decision
      // is a pure function of (status, isEmpty, counter, threshold) so it
      // lives in `runawayGuardStep` for unit-testability. Critically, when
      // status === 'waiting_gate' we reset the counter and do not fire:
      // the runner is legitimately blocked awaiting user input, and any
      // empty/thinking turns the model emits under that condition are not
      // a runaway signal. Without this gate-aware short-circuit, empty
      // turns leaking in just before / during a gate would trip the
      // interrupt and kill the gate (regression after commit 083d7a9).
      const guardDecision = runawayGuardStep({
        status: ctx.state.status,
        isEmpty: isAssistantContentEmpty(event.content as unknown[]),
        counter: self.consecutiveEmptyAssistantTurns,
        threshold: RUNAWAY_EMPTY_TURN_THRESHOLD,
      })
      self.consecutiveEmptyAssistantTurns = guardDecision.nextCounter
      if (guardDecision.shouldFire) {
        self.fireRunawayInterrupt(
          'runaway_empty_assistant_turns',
          '⚠ Session auto-stopped: detected repeated empty assistant turns (model runaway).',
          { kind: 'empty', consecutive: guardDecision.nextCounter },
        )
        break
      }

      // Repeated-content guard: detect the "stuck-content" runaway flavor
      // the empty-turn guard misses (model wedged emitting near-identical
      // non-empty turns, prompt-feedback loop, Stop-hook redirect loop).
      // Same gate-aware short-circuit; tool-use turns are skipped via
      // null fingerprint (varying tool args = legitimate progress).
      const fingerprint = fingerprintAssistantContent(event.content as unknown[])
      const repeatDecision = repeatedTurnGuardStep({
        status: ctx.state.status,
        fingerprint,
        recent: self.recentTurnFingerprints,
        threshold: REPEATED_TURN_THRESHOLD,
      })
      self.recentTurnFingerprints = repeatDecision.nextRecent
      if (repeatDecision.shouldFire) {
        self.fireRunawayInterrupt(
          'repeated_assistant_turns',
          '⚠ Session auto-stopped: detected repeated assistant turns (model wedge / hook loop).',
          { kind: 'repeated', consecutive: repeatDecision.nextRecent.length },
        )
        break
      }

      // Final assistant message — finalize streaming parts with final content
      const newParts = event.parts
        ? wireToSessionParts(event.parts)
        : assistantContentToParts(event.content as unknown[])
      const msgId = self.currentTurnMessageId ?? `msg-${self.turnCounter}`

      // Merge finalizes any streaming text/reasoning parts (preserving the
      // text accumulated from partial_assistant deltas) and appends newParts
      // while avoiding duplicating text/reasoning that already streamed — the
      // SDK's final assistant event may or may not re-emit thinking blocks,
      // so the authoritative copy of extended-thinking traces is the streamed
      // one. See mergeFinalAssistantParts + its regression-guard tests.
      const existing = ctx.session.getMessage(msgId)
      const mergedParts = mergeFinalAssistantParts(existing?.parts, newParts)

      const msg: SessionMessage = {
        id: msgId,
        role: 'assistant',
        parts: mergedParts,
        createdAt: existing?.createdAt ?? new Date(),
      }
      try {
        if (existing) {
          self.safeUpdateMessage(msg)
        } else {
          // No partial fired first — append from scratch. Parent defaults to
          // latestLeafRow(), which is the user row this assistant replies
          // to. See partial_assistant branch for the full rationale.
          self.safeAppendMessage(msg)
        }
        self.currentTurnMessageId = null
        self.persistTurnState()
        broadcastMessagesImpl(ctx, [msg as unknown as WireSessionMessage])
      } catch (err) {
        console.error('[session-do] event persist failed', err)
      }
      self.updateState({ num_turns: ctx.state.num_turns + 1 })
      break
    }

    case 'tool_result': {
      self.clearAwaitingResponse()
      // Update the current assistant message's tool parts with results
      const currentMsgId = self.currentTurnMessageId ?? `msg-${self.turnCounter}`
      const existing = ctx.session.getMessage(currentMsgId)
      if (existing) {
        const updatedParts = applyToolResult(existing.parts, event)
        const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
        try {
          self.safeUpdateMessage(updatedMsg)
          broadcastMessagesImpl(ctx, [updatedMsg as unknown as WireSessionMessage])
        } catch (err) {
          console.error('[session-do] event persist failed', err)
        }
      }
      break
    }

    case 'ask_user': {
      self.clearAwaitingResponse()
      // Reset runaway-empty-turn counter: an empty/thinking-only assistant
      // event may have arrived just before the gate (putting the counter
      // near threshold), and the gate itself is the definitive "not a
      // runaway" signal. Belt-and-braces with the waiting_gate
      // short-circuit in `case 'assistant'`.
      self.consecutiveEmptyAssistantTurns = 0
      // No part-type / state promotion here. The client renders a
      // GateResolver directly off the SDK-native
      // `tool-AskUserQuestion` / `input-available` shape already in the
      // assistant message, so flipping to `tool-ask_user` /
      // `approval-requested` would be a redundant second write to the
      // same row — and produced a race where a fast user's resolveGate
      // RPC beat this event to the DO, resolveGate advanced state to
      // `output-available`, then this handler regressed it back to
      // `approval-requested` and left the UI stuck. The part's own
      // state is the single writer now; resolveGate → tool_result
      // advances it monotonically.

      const askedQuestions = Array.isArray(event.questions) ? event.questions : []
      const askedSummary = askedQuestions.map((q, idx) => {
        const qq = q as Record<string, unknown>
        return {
          idx,
          header: typeof qq?.header === 'string' ? (qq.header as string).slice(0, 80) : null,
          questionLen: typeof qq?.question === 'string' ? (qq.question as string).length : null,
          optionsCount: Array.isArray(qq?.options) ? (qq.options as unknown[]).length : null,
          multiSelect: typeof qq?.multiSelect === 'boolean' ? qq.multiSelect : null,
        }
      })
      ctx.logEvent(
        'info',
        'gate',
        `ask_user received toolCallId=${event.tool_call_id} questions_count=${askedQuestions.length}`,
        {
          doId: ctx.ctx.id.toString(),
          sessionId: ctx.state.session_id,
          toolCallId: event.tool_call_id,
          questionsCount: askedQuestions.length,
          summary: askedSummary,
        },
      )

      // Race guard: if resolveGate has already advanced the matching
      // part to a terminal state, announcing the gate now would leave
      // status=waiting_gate dangling + fire a push for a gate that's
      // already closed. Check the part state directly.
      const alreadyResolved = ctx.session
        .getHistory()
        .some((m) =>
          m.parts.some(
            (p) =>
              p.toolCallId === event.tool_call_id &&
              (p.state === 'output-available' ||
                p.state === 'output-error' ||
                p.state === 'output-denied' ||
                p.state === 'approval-given' ||
                p.state === 'approval-denied'),
          ),
        )
      if (alreadyResolved) {
        ctx.logEvent(
          'info',
          'gate',
          `ask_user short-circuit already_resolved toolCallId=${event.tool_call_id}`,
          {
            toolCallId: event.tool_call_id,
          },
        )
        break
      }

      // Status flip + push notification are still load-bearing: UI
      // status indicators and notifications need to distinguish
      // "running" from "blocked on user answer." (#76 P3: gate scalar
      // removed — messages are the sole gate source.)
      self.updateState({ status: 'waiting_gate' })
      ctx.ctx.waitUntil(
        self.dispatchPush(
          {
            title: ctx.state.project || 'Duraclaw',
            body: `Asking: ${((event.questions?.[0] as Record<string, unknown>)?.question as string)?.slice(0, 100) || 'Question'}`,
            url: `/?session=${ctx.do.name}`,
            tag: `session-${ctx.do.name}`,
            sessionId: ctx.do.name,
            actions: [{ action: 'open', title: 'Open' }],
          },
          'blocked',
        ),
      )
      break
    }

    case 'permission_request': {
      self.clearAwaitingResponse()
      // Reset runaway-empty-turn counter (same rationale as ask_user).
      self.consecutiveEmptyAssistantTurns = 0
      // Same strategy as ask_user: promote the existing tool part created
      // by the assistant event rather than appending a duplicate.
      const permPromoteResult = promoteToolPartToGateImpl(
        ctx,
        event.tool_call_id,
        'tool-permission',
        'permission',
        { tool_name: event.tool_name, tool_call_id: event.tool_call_id },
      )

      // Same race guard as ask_user (see above).
      if (permPromoteResult === 'already-resolved') {
        break
      }

      // Status flip + action token + push are still
      // load-bearing. (#76 P3: gate scalar removed.)
      self.updateState({ status: 'waiting_gate' })
      ctx.ctx.waitUntil(
        (async () => {
          try {
            const actionToken = await generateActionToken(
              ctx.do.name,
              event.tool_call_id,
              ctx.env.BETTER_AUTH_SECRET,
            )
            await self.dispatchPush(
              {
                title: ctx.state.project || 'Duraclaw',
                body: `Needs permission: ${event.tool_name}`,
                url: `/?session=${ctx.do.name}`,
                tag: `session-${ctx.do.name}`,
                sessionId: ctx.do.name,
                actionToken,
                actions: [
                  { action: 'approve', title: 'Allow' },
                  { action: 'deny', title: 'Deny' },
                ],
              },
              'blocked',
            )
          } catch (err) {
            console.error(`[SessionDO:${ctx.ctx.id}] Failed to generate action token:`, err)
          }
        })(),
      )
      break
    }

    case 'file_changed': {
      // Add file_changed data part to current assistant message
      const currentMsgId = self.currentTurnMessageId ?? `msg-${self.turnCounter}`
      const existing = ctx.session.getMessage(currentMsgId)
      if (existing) {
        const updatedParts: SessionMessagePart[] = [
          ...existing.parts,
          {
            type: 'data-file-changed',
            text: event.path,
            state: event.tool === 'write' ? 'created' : 'modified',
          },
        ]
        const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
        try {
          self.safeUpdateMessage(updatedMsg)
          broadcastMessagesImpl(ctx, [updatedMsg as unknown as WireSessionMessage])
        } catch (err) {
          console.error(`[SessionDO:${ctx.ctx.id}] Failed to persist file_changed:`, err)
        }
      }
      break
    }

    case 'result': {
      self.clearAwaitingResponse()
      // GH#75 P1.2 B7 — REORDER GUARD: all per-message broadcast frames
      // for this turn MUST fire before we flip state to `idle`. If status
      // flips first the sidebar can resolve to idle while the final
      // assistant frame is still in flight. The `finalizeResultTurn`
      // helper encodes the ordering by construction; do not inline the
      // phases without preserving that invariant.
      const _now = new Date().toISOString()
      finalizeResultTurn({
        broadcastPhase: () => {
          // Finalize orphaned streaming parts
          if (self.currentTurnMessageId) {
            const existing = ctx.session.getMessage(self.currentTurnMessageId)
            if (existing) {
              const finalizedParts = finalizeStreamingParts(existing.parts)
              self.safeUpdateMessage({ ...existing, parts: finalizedParts })
              broadcastMessagesImpl(ctx, [
                { ...existing, parts: finalizedParts } as unknown as WireSessionMessage,
              ])
            }
            self.currentTurnMessageId = null
            self.persistTurnState()
          }

          // If SDK reported an error result, show it inline as a system message
          if (event.is_error && event.result) {
            self.turnCounter++
            const errorMsgId = `err-${self.turnCounter}`
            const errorMsg: SessionMessage = {
              id: errorMsgId,
              role: 'system',
              parts: [{ type: 'text', text: `⚠ Error: ${event.result}` }],
              createdAt: new Date(),
            }
            self.safeAppendMessage(errorMsg)
            broadcastMessagesImpl(ctx, [errorMsg as unknown as WireSessionMessage])
          }

          // If the SDK result contains text that isn't already in the last message,
          // append it as a visible assistant message so the final response is shown.
          if (!event.is_error && event.result && typeof event.result === 'string') {
            const lastMsgId = `msg-${self.turnCounter}`
            const lastMsg = ctx.session.getMessage(lastMsgId)
            const lastHasText = lastMsg?.parts?.some(
              (p) => p.type === 'text' && p.state === 'done' && p.text,
            )
            if (!lastHasText) {
              // The last assistant turn had only tool calls, no final text — add result text
              if (lastMsg) {
                const updatedParts: SessionMessagePart[] = [
                  ...lastMsg.parts,
                  { type: 'text', text: event.result, state: 'done' },
                ]
                const updatedMsg: SessionMessage = { ...lastMsg, parts: updatedParts }
                self.safeUpdateMessage(updatedMsg)
                broadcastMessagesImpl(ctx, [updatedMsg as unknown as WireSessionMessage])
              } else {
                self.turnCounter++
                const resultMsgId = `msg-${self.turnCounter}`
                const resultMsg: SessionMessage = {
                  id: resultMsgId,
                  role: 'assistant',
                  parts: [{ type: 'text', text: event.result, state: 'done' }],
                  createdAt: new Date(),
                }
                self.safeAppendMessage(resultMsg)
                broadcastMessagesImpl(ctx, [resultMsg as unknown as WireSessionMessage])
              }
            }
          }
        },
        updateStateIdle: () => {
          // PRESERVE all existing side effects — always transition to idle.
          // NOTE: `type=result` is a *turn-complete* signal from the SDK, not a
          // session-complete signal. The session-runner stays alive waiting on
          // stream-input for the next turn (see claude-runner multi-turn loop),
          // so we keep active_callback_token intact — clearing it would block the
          // runner from re-dialling if its WS flaps. The token is cleared only
          // on true terminal transitions (stopped/failed/aborted/crashed).
          // Spec #101 P1.2 B9 — cost delegation. Trust the runner's
          // reported `total_cost_usd` for adapters that emit USD cost
          // (Claude SDK). For adapters that don't (capabilities.emitsUsdCost
          // === false), keep the existing cached value untouched rather
          // than zeroing or accumulating zero. No client-side recomputation.
          const emitsUsdCost = ctx.state.capabilities?.emitsUsdCost ?? true
          const nextTotalCost = emitsUsdCost
            ? (ctx.state.total_cost_usd ?? 0) + (event.total_cost_usd ?? 0)
            : ctx.state.total_cost_usd
          self.updateState({
            status: 'idle',
            completed_at: new Date().toISOString(),
            result: event.result,
            duration_ms: (ctx.state.duration_ms ?? 0) + (event.duration_ms ?? 0),
            total_cost_usd: nextTotalCost,
            num_turns: ctx.state.num_turns + (event.num_turns ?? 0),
            error: event.is_error ? event.result : null,
            summary: event.sdk_summary ?? ctx.state.summary,
          })
        },
        syncResultToD1: () => {
          void syncResultToD1Impl(ctx, _now)
        },
      })
      // Spec #37 B9: the legacy per-turn summary WS frame is retired —
      // numTurns / totalCostUsd / durationMs now reach the client via the
      // `agent_sessions` synced-collection delta emitted by syncResultToD1
      // → broadcastSessionRow above.
      // Discovered-session fan-out is now owned by the cron in
      // src/api/scheduled.ts (#7 p6); SessionDO no longer mirrors here.
      if (!event.is_error) {
        // Body = last assistant message text (SDK `result` field). Falls
        // back to the stats line only when the SDK didn't emit a result
        // string (rare — adapters that don't surface a final turn text).
        const lastAssistantText = typeof event.result === 'string' ? event.result.trim() : ''
        const PUSH_BODY_MAX = 200
        const completedBody = lastAssistantText
          ? lastAssistantText.length > PUSH_BODY_MAX
            ? `${lastAssistantText.slice(0, PUSH_BODY_MAX - 1).trimEnd()}…`
            : lastAssistantText
          : `Completed (${ctx.state.num_turns} turns, $${(ctx.state.total_cost_usd ?? 0).toFixed(2)})`
        ctx.ctx.waitUntil(
          self.dispatchPush(
            {
              title: ctx.state.project || 'Duraclaw',
              body: completedBody,
              url: `/?session=${ctx.do.name}`,
              tag: `session-${ctx.do.name}`,
              sessionId: ctx.do.name,
              actions: [
                { action: 'open', title: 'Open' },
                { action: 'new-session', title: 'New Session' },
              ],
            },
            'completed',
          ),
        )
      } else {
        ctx.ctx.waitUntil(
          self.dispatchPush(
            {
              title: ctx.state.project || 'Duraclaw',
              body: `Failed: ${event.result || 'Session failed'}`,
              url: `/?session=${ctx.do.name}`,
              tag: `session-${ctx.do.name}`,
              sessionId: ctx.do.name,
            },
            'error',
          ),
        )
      }
      break
    }

    case 'stopped': {
      self.clearAwaitingResponse()
      // Finalize orphaned streaming parts
      if (self.currentTurnMessageId) {
        const existing = ctx.session.getMessage(self.currentTurnMessageId)
        if (existing) {
          const finalizedParts = finalizeStreamingParts(existing.parts)
          self.safeUpdateMessage({ ...existing, parts: finalizedParts })
        }
        self.currentTurnMessageId = null
        self.persistTurnState()
      }

      // PRESERVE existing side effects; clear active_callback_token (terminal).
      self.updateState({
        status: 'idle',
        completed_at: new Date().toISOString(),
        active_callback_token: undefined,
      })
      // Chain auto-advance fires after updateState has broadcast the
      // idle status. tryAutoAdvance's preconditions query agent_sessions
      // expecting status='idle' + numTurns>0.
      ctx.ctx.waitUntil(
        self
          .maybeAutoAdvanceChain()
          .catch((err) => console.error('[session-do] post-stop chain:', err)),
      )
      // GH#115 §B-LIFECYCLE-2: release-on-close. Last-session check
      // inside the helper handles arc-shared chains where a successor
      // is still running. Fire-and-forget; the cron janitor is the
      // safety net if this ever fails.
      maybeReleaseWorktreeOnTerminal(ctx)
      break
    }

    case 'kata_state': {
      // PRESERVE existing side effects — store in kv and sync to D1.
      try {
        ctx.do
          .sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('kata_state', ${JSON.stringify(event.kata_state)})`
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] Failed to persist kata state:`, err)
      }
      {
        const _now = new Date().toISOString()
        void syncKataAllToD1Impl(ctx, event.kata_state, _now)
      }

      // GH#73: persist the runEnded evidence bit whenever it changes.
      // chain auto-advance reads this on the post-stop gate — the runner
      // emits a fresh kata_state frame each time run-end.json appears, so
      // by the time the session lands in 'idle' the bit is already durable.
      {
        const nextRunEnded = event.kata_state?.runEnded === true
        if ((ctx.state.lastRunEnded ?? false) !== nextRunEnded) {
          self.updateState({ lastRunEnded: nextRunEnded })
        }
      }

      // Chain UX P4: detect mode transitions on chain-linked sessions and
      // reset the runner so each mode gets a fresh SDK session context.
      const ks = event.kata_state
      if (ks?.currentMode && ks.issueNumber != null) {
        const prev = ctx.state.lastKataMode
        const next = ks.currentMode
        if (prev !== next) {
          self.updateState({ lastKataMode: next })
          // Initial mode observation on a fresh session is NOT a transition —
          // only rotate the runner when we've seen a prior mode. Firing
          // handleModeTransition on the first kata_state would kill the
          // runner that just spawned with the user's typed prompt and
          // replace it with the mode-preamble text.
          if (prev == null) {
            console.log(
              `[SessionDO:${ctx.ctx.id}] initial mode observed: ${next} — no runner reset`,
            )
          } else if (ks.continueSdk === true) {
            console.log(
              `[SessionDO:${ctx.ctx.id}] mode change ${prev}→${next} with continueSdk=true, skipping reset`,
            )
          } else {
            // Fire-and-forget — the runner close + respawn involves multi-
            // second awaits that shouldn't block gateway event processing.
            self.handleModeTransition(ks, prev).catch((err) => {
              console.error(`[SessionDO:${ctx.ctx.id}] handleModeTransition failed:`, err)
            })
          }
        }
      }
      break
    }

    case 'error': {
      self.clearAwaitingResponse()
      // Finalize orphaned streaming parts
      if (self.currentTurnMessageId) {
        const existing = ctx.session.getMessage(self.currentTurnMessageId)
        if (existing) {
          const finalizedParts = finalizeStreamingParts(existing.parts)
          self.safeUpdateMessage({ ...existing, parts: finalizedParts })
        }
        self.currentTurnMessageId = null
        self.persistTurnState()
      }

      // Persist error as a visible system message so user sees what happened
      self.turnCounter++
      const errorMsgId = `err-${self.turnCounter}`
      const errorMsg: SessionMessage = {
        id: errorMsgId,
        role: 'system',
        parts: [{ type: 'text', text: `⚠ Error: ${event.error}` }],
        createdAt: new Date(),
      }
      self.safeAppendMessage(errorMsg)
      broadcastMessagesImpl(ctx, [errorMsg as unknown as WireSessionMessage])

      // Transition to idle — session remains interactive and resumable via
      // runner_session_id. The error text is already persisted as a visible
      // system message (see above). Clears active_callback_token so the
      // current runner is terminal; sendMessage will dial a fresh resume runner
      // on the user's next turn.
      self.updateState({
        status: 'idle',
        error: event.error,
        active_callback_token: undefined,
      })
      if (event.error) {
        const _now = new Date().toISOString()
        try {
          const sessionId = ctx.do.name
          ctx.ctx.waitUntil(
            ctx.do.d1
              .update(agentSessions)
              .set({
                error: event.error,
                updatedAt: _now,
                lastActivity: _now,
                messageSeq: ctx.do.messageSeq,
              })
              .where(eq(agentSessions.id, sessionId))
              .then(() => broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')),
          )
        } catch (err) {
          console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync error to D1:`, err)
        }
      }
      ctx.ctx.waitUntil(
        self.dispatchPush(
          {
            title: ctx.state.project || 'Duraclaw',
            body: `Error: ${event.error}`,
            url: `/?session=${ctx.do.name}`,
            tag: `session-${ctx.do.name}`,
            sessionId: ctx.do.name,
          },
          'error',
        ),
      )
      // GH#115 §B-LIFECYCLE-2: release-on-close (terminal error path).
      maybeReleaseWorktreeOnTerminal(ctx)
      break
    }

    // P3 B4: parse `context_usage` to `ContextUsage`, drain probe resolvers,
    // GH#86: Haiku-generated session title. Runner emits this after a
    // successful Haiku call (initial title or pivot retitle). The DO
    // applies iff title_source !== 'user' (B4 never-clobber invariant),
    // persists to session_meta + D1, and broadcasts via broadcastSessionRow.
    case 'title_update': {
      handleTitleUpdate(ctx, event)
      break
    }

    // context_usage was folded into the `result` event by #102 — no
    // separate wire event anymore. Context usage is now extracted from
    // the result event's payload in the 'result' case above.

    case 'rate_limit': {
      // Spec #101 Stage 3: route rate-limit events through the
      // resume-scheduler module. Currently a stub that falls through
      // to the broadcast path; CAAM logic will land here.
      void handleRateLimit(ctx, event)
      self.broadcastGatewayEvent(event)
      break
    }

    case 'task_started':
      self.broadcastGatewayEvent(event)
      break

    case 'task_progress':
      self.broadcastGatewayEvent(event)
      break

    case 'task_notification':
      self.broadcastGatewayEvent(event)
      break

    case 'chain_advance':
      self.broadcastGatewayEvent(event)
      break

    case 'chain_stalled':
      self.broadcastGatewayEvent(event)
      break

    case 'compact_boundary':
      self.broadcastGatewayEvent(event)
      break

    case 'api_retry':
      self.broadcastGatewayEvent(event)
      break

    // GH#102 / spec 102-sdk-peelback B1: SDK-native liveness signal.
    // Broadcast-only — DO does not mutate ctx.state.status from this
    // event; the existing result/sendMessage/spawn handlers drive status
    // transitions. The frame goes to clients so transient
    // compacting/api_retry/running indicators can render.
    case 'session_state_changed':
      self.broadcastGatewayEvent(event)
      break

    default: {
      // TS exhaustiveness — every member of GatewayEvent must be handled above.
      // If you see a build error here, you've added a new event type to the
      // GatewayEvent union without wiring up a case in this switch.
      const _exhaustive: never = event
      // Runtime resilience: if an out-of-version runner ships an event type
      // before this DO knows about it, log + drop rather than throw. The
      // exhaustiveness check above prevents the in-tree case at compile time.
      console.warn(
        `[session-do] unhandled gateway event type=${(_exhaustive as { type: string }).type ?? 'unknown'}`,
      )
      break
    }
  }
}

// ── Stage 6 absorbed helpers (formerly session-do-helpers.ts) ──────────

/**
 * GH#75 P1.2 B7: source-ordering invariant for the `result` event handler.
 *
 * The handler must emit every final-turn `broadcastMessage` frame BEFORE it
 * transitions state to `idle` and BEFORE it flushes status to D1. Client
 * derived-status (spec #31) folds over `messagesCollection`, so if the
 * `updateState({status:'idle'})` lands first the top-level mirror can flip
 * the sidebar to idle while the final assistant turn is still in flight
 * and get overwritten back to the pre-result message on arrival.
 *
 * NOTE: all callbacks are invoked synchronously in the listed order. The
 * helper does NOT await any returned promises — the D1 sync fns are
 * fire-and-forget in the real handler and we preserve that behavior.
 */
export interface FinalizeResultTurnCallbacks {
  /** Emit every per-message frame for the completed turn (orphan finalize,
   * error system message, result-text append). */
  broadcastPhase: () => void
  /** Transition DO state to `idle` with the result summary fields. */
  updateStateIdle: () => void
  /** Fire-and-forget D1 sync of the result columns (includes status). */
  syncResultToD1: () => void
}

export function finalizeResultTurn(cbs: FinalizeResultTurnCallbacks): void {
  cbs.broadcastPhase()
  cbs.updateStateIdle()
  cbs.syncResultToD1()
}

/**
 * Runaway-empty-assistant-turn guard step (pure decision).
 *
 * The DO tracks `consecutiveEmptyAssistantTurns` to catch the prod-incident
 * failure mode where the SDK emits a flood of effectively-empty assistant
 * events. Decision rules:
 *   - status === 'waiting_gate'  → reset counter, do not fire (gate-pending)
 *   - empty content              → increment; fire when ≥ threshold
 *   - non-empty (substantive)    → reset counter
 */
export interface RunawayGuardInput {
  status: string | undefined
  isEmpty: boolean
  counter: number
  threshold: number
}
export interface RunawayGuardDecision {
  nextCounter: number
  shouldFire: boolean
}
export function runawayGuardStep(input: RunawayGuardInput): RunawayGuardDecision {
  if (input.status === 'waiting_gate') {
    return { nextCounter: 0, shouldFire: false }
  }
  if (input.isEmpty) {
    const nextCounter = input.counter + 1
    return { nextCounter, shouldFire: nextCounter >= input.threshold }
  }
  return { nextCounter: 0, shouldFire: false }
}

/**
 * Repeated-assistant-turn guard step (pure decision).
 *
 * Catches the "stuck-content" runaway flavor that the empty-turn guard
 * misses: model wedged emitting near-identical non-empty turns.
 *
 * Decision rules:
 *   - status === 'waiting_gate'     → clear ring, do not fire (gate-pending)
 *   - fingerprint === null          → skip (tool_use turn, empty turn —
 *                                     ring untouched, defer to other guards)
 *   - otherwise                     → append to ring (capped at threshold);
 *                                     fire when ring is full AND every
 *                                     entry equals the newest fingerprint
 */
export interface RepeatedTurnGuardInput {
  status: string | undefined
  fingerprint: string | null
  recent: readonly string[]
  threshold: number
}
export interface RepeatedTurnGuardDecision {
  nextRecent: string[]
  shouldFire: boolean
}
export function repeatedTurnGuardStep(input: RepeatedTurnGuardInput): RepeatedTurnGuardDecision {
  if (input.status === 'waiting_gate') {
    return { nextRecent: [], shouldFire: false }
  }
  if (input.fingerprint === null) {
    return { nextRecent: [...input.recent], shouldFire: false }
  }
  const appended = [...input.recent, input.fingerprint]
  const nextRecent = appended.slice(-input.threshold)
  const shouldFire =
    nextRecent.length >= input.threshold && nextRecent.every((fp) => fp === nextRecent[0])
  return { nextRecent, shouldFire }
}
