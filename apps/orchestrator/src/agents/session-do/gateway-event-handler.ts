import type { SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'
import { eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import { generateActionToken } from '~/lib/action-token'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import type { ContextUsage, GatewayEvent } from '~/lib/types'
import {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  fingerprintAssistantContent,
  isAssistantContentEmpty,
  mergeFinalAssistantParts,
  partialAssistantToParts,
} from '../gateway-event-mapper'
import { broadcastMessages as broadcastMessagesImpl } from './broadcast'
import { promoteToolPartToGate as promoteToolPartToGateImpl } from './gates'
import { handleRateLimit } from './resume-scheduler'
import {
  syncKataAllToD1 as syncKataAllToD1Impl,
  syncResultToD1 as syncResultToD1Impl,
  syncSdkSessionIdToD1 as syncSdkSessionIdToD1Impl,
} from './status'
import { handleTitleUpdate } from './title'
import {
  REPEATED_TURN_THRESHOLD,
  RUNAWAY_EMPTY_TURN_THRESHOLD,
  type SessionDOContext,
} from './types'

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

    case 'session.init':
      self.updateState({ sdk_session_id: event.sdk_session_id, model: event.model })
      // Sync sdk_session_id to D1 so discovery won't create a duplicate row.
      if (event.sdk_session_id) {
        void syncSdkSessionIdToD1Impl(ctx, event.sdk_session_id, new Date().toISOString())
      }
      break

    case 'partial_assistant': {
      self.clearAwaitingResponse()
      const parts = partialAssistantToParts(event.content)
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
      const newParts = assistantContentToParts(event.content as unknown[])
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
            url: `/?session=${ctx.state.session_id}`,
            tag: `session-${ctx.state.session_id}`,
            sessionId: ctx.state.session_id ?? '',
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
              ctx.state.session_id ?? '',
              event.tool_call_id,
              ctx.env.BETTER_AUTH_SECRET,
            )
            await self.dispatchPush(
              {
                title: ctx.state.project || 'Duraclaw',
                body: `Needs permission: ${event.tool_name}`,
                url: `/?session=${ctx.state.session_id}`,
                tag: `session-${ctx.state.session_id}`,
                sessionId: ctx.state.session_id ?? '',
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
          self.updateState({
            status: 'idle',
            completed_at: new Date().toISOString(),
            result: event.result,
            duration_ms: (ctx.state.duration_ms ?? 0) + (event.duration_ms ?? 0),
            total_cost_usd: (ctx.state.total_cost_usd ?? 0) + (event.total_cost_usd ?? 0),
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
        ctx.ctx.waitUntil(
          self.dispatchPush(
            {
              title: ctx.state.project || 'Duraclaw',
              body: `Completed (${ctx.state.num_turns} turns, $${(ctx.state.total_cost_usd ?? 0).toFixed(2)})`,
              url: `/?session=${ctx.state.session_id}`,
              tag: `session-${ctx.state.session_id}`,
              sessionId: ctx.state.session_id ?? '',
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
              url: `/?session=${ctx.state.session_id}`,
              tag: `session-${ctx.state.session_id}`,
              sessionId: ctx.state.session_id ?? '',
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
      // sdk_session_id. The error text is already persisted as a visible
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
            url: `/?session=${ctx.state.session_id}`,
            tag: `session-${ctx.state.session_id}`,
            sessionId: ctx.state.session_id ?? '',
          },
          'error',
        ),
      )
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

    // and update `session_meta.context_usage_json` + cached_at. The original
    // gateway_event broadcast is retained (per P3 brief Non-Goals: keep
    // existing client handlers live until the deferred consumer-migration
    // issue swaps them to REST).
    case 'context_usage': {
      const rawUsage = event.usage ?? {}
      const parsed: ContextUsage = {
        totalTokens: (rawUsage.totalTokens as number) ?? 0,
        maxTokens: (rawUsage.maxTokens as number) ?? 0,
        percentage: (rawUsage.percentage as number) ?? 0,
        model: rawUsage.model as string | undefined,
        isAutoCompactEnabled: rawUsage.isAutoCompactEnabled as boolean | undefined,
        autoCompactThreshold: rawUsage.autoCompactThreshold as number | undefined,
      }
      // Drain any awaiters first so they settle on the fresh value rather
      // than the pre-write cache.
      const resolvers = self.contextUsageResolvers.splice(0)
      for (const r of resolvers) {
        try {
          r.resolve(parsed)
        } catch {
          // Defensive: never let a resolver throw tank the event loop.
        }
      }
      // Persist into the typed session_meta cache so subsequent calls
      // within the 5s TTL hit the fresh row without re-probing.
      try {
        const cachedAt = Date.now()
        ctx.do.sql`UPDATE session_meta
          SET context_usage_json = ${JSON.stringify(parsed)},
              context_usage_cached_at = ${cachedAt},
              updated_at = ${cachedAt}
          WHERE id = 1`
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] Failed to persist context_usage cache:`, err)
      }
      // Spec #37 B5: mirror context_usage onto the D1 session row with a 5s
      // trailing-edge debounce so sidebar / history cards track live usage.
      self.syncContextUsageToD1(JSON.stringify(parsed))
      // Retained WS broadcast — consumer migration is a separate issue.
      self.broadcastGatewayEvent(event)
      break
    }

    // Events that don't produce message parts — just broadcast raw
    default: {
      // GH#50 B9: tolerant drop for legacy events from in-flight pre-B7
      // runners during the rollout window. These frames are logged once
      // then silently dropped.
      const type = (event as { type: string }).type
      if (type === 'heartbeat') {
        // Runner heartbeat — liveness proof. `lastGatewayActivity` was
        // already bumped by the generic `onMessage` handler; nothing else
        // to do. Not broadcast to clients.
        break
      }
      if (type === 'rate_limit') {
        // Spec #101 Stage 3: route rate-limit events through the
        // resume-scheduler module. Currently a stub that falls through
        // to the default broadcast path; CAAM logic will land here.
        void handleRateLimit(ctx, event as Extract<GatewayEvent, { type: 'rate_limit' }>)
        self.broadcastGatewayEvent(event)
        break
      }
      if (type === 'session_state_changed') {
        const sid =
          (event as { session_id?: string | null }).session_id ?? ctx.state.session_id ?? null
        // GH#50 B9: tolerant log-once-then-drop for legacy event types
        // (`heartbeat`, `session_state_changed`) emitted by pre-P3 runners
        // during the rollout window. Liveness bump (B1) runs BEFORE this
        // drop so the legacy frame still refreshes the TTL — clients with
        // P2 shipped never see a flap.
        if (!ctx.do.loggedLegacyEventTypes.has(type)) {
          console.warn(
            `[session-do] dropped legacy event type=${type} sessionId=${sid ?? 'unknown'}`,
          )
          ctx.do.loggedLegacyEventTypes.add(type)
        }
        break
      }
      // rewind_result, task_started, task_progress, task_notification —
      // broadcast as-is
      self.broadcastGatewayEvent(event)
      break
    }
  }
}

// ── Stage 6 absorbed helpers (formerly session-do-helpers.ts) ──────────

/**
 * GH#50 B9: legacy event types that pre-B7 session-runners still emit
 * while parked in `waitForNext()`. They are logged-once-then-dropped by
 * `handleGatewayEvent`'s default branch.
 */
export const LEGACY_DROPPED_EVENT_TYPES = ['heartbeat', 'session_state_changed'] as const
export type LegacyDroppedEventType = (typeof LEGACY_DROPPED_EVENT_TYPES)[number]

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
