import type { SessionMessage } from 'agents/experimental/memory/session'
import { transcriptUserContentToParts } from '~/lib/message-parts'
import { applyToolResult, assistantContentToParts, upsertParts } from './message-parts'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted body of `SessionDO.hydrateFromGateway()`.
 *
 * Pulls the SDK-side transcript for `(project, runner_session_id)` from the
 * gateway and merges new events into local history. Skips entries already
 * persisted (counted by `getPathLength()`); tool_result events apply to
 * the prior assistant message; consecutive assistant events on the same
 * turn merge via `upsertParts` to mirror live-stream merge behavior.
 * Idempotent: a second invocation after a successful hydrate is a no-op.
 */
export async function hydrateFromGatewayImpl(ctx: SessionDOContext): Promise<void> {
  const gatewayUrl = ctx.env.CC_GATEWAY_URL
  if (!gatewayUrl || !ctx.state.runner_session_id || !ctx.state.project) return

  const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const url = new URL(
    `/projects/${encodeURIComponent(ctx.state.project)}/sessions/${encodeURIComponent(ctx.state.runner_session_id)}/messages`,
    httpBase,
  )
  const headers: Record<string, string> = {}
  if (ctx.env.CC_GATEWAY_SECRET) {
    headers.Authorization = `Bearer ${ctx.env.CC_GATEWAY_SECRET}`
  }

  try {
    const resp = await fetch(url.toString(), { headers })
    if (!resp.ok) {
      console.error(
        `[SessionDO:${ctx.ctx.id}] Gateway hydration failed: ${resp.status} ${resp.statusText}`,
      )
      return
    }
    const data = (await resp.json()) as {
      messages: Array<{ type: string; uuid: string; content: unknown[] }>
    }
    if (!data.messages?.length) return

    // Count how many user/assistant messages we already have locally.
    // We skip that many from the gateway transcript to avoid duplicates.
    const localHistory = ctx.session.getPathLength()
    let skipped = 0

    let persisted = 0
    let lastMsgId: string | null = null
    // Tracks the in-progress assistant message across multi-cycle turns so
    // that consecutive SDK `assistant` events (text → tool_use per cycle)
    // merge into a single local message, matching live-stream behavior.
    // Reset on every `user` event (turn boundary).
    let currentAssistantMsgId: string | null = null

    // If we have local messages, set lastMsgId to the latest one so new
    // messages get appended to the end of the existing tree. If the tail is
    // an assistant message, treat it as the in-progress turn accumulator so
    // new assistant events from the transcript merge into it (multi-cycle
    // turns where live streaming already built a merged message).
    if (localHistory > 0) {
      const history = ctx.session.getHistory()
      if (history.length > 0) {
        const tail = history[history.length - 1]
        lastMsgId = tail.id
        if (tail.role === 'assistant') {
          currentAssistantMsgId = tail.id
        }
      }
    }

    for (const msg of data.messages) {
      // Skip user/assistant messages we already persisted
      if (msg.type === 'user' || msg.type === 'assistant') {
        if (skipped < localHistory) {
          skipped++
          continue
        }
      }
      // Also skip tool_results that belong to already-persisted messages
      if (msg.type === 'tool_result' && skipped <= localHistory && persisted === 0) {
        continue
      }

      if (msg.type === 'user') {
        // Filter out tool_result blocks from user message content — those are handled
        // as separate tool_result events. If only tool_result blocks remain, skip entirely.
        let content = msg.content
        if (Array.isArray(content)) {
          const filtered = content.filter(
            (c: unknown) => (c as Record<string, unknown>)?.type !== 'tool_result',
          )
          if (filtered.length === 0) {
            // User message contained only tool_result blocks — skip
            continue
          }
          content = filtered
        }

        ctx.do.turnCounter++
        const msgId = `usr-${ctx.do.turnCounter}`
        const sessionMsg: SessionMessage = {
          id: msgId,
          role: 'user',
          parts: transcriptUserContentToParts(content),
          createdAt: new Date(),
        }
        await ctx.do.safeAppendMessage(sessionMsg, lastMsgId)
        lastMsgId = msgId
        // A new user message ends any in-progress assistant turn — reset the
        // accumulator so the next assistant event starts a fresh message.
        currentAssistantMsgId = null
        persisted++
      } else if (msg.type === 'assistant') {
        const newParts = assistantContentToParts(msg.content)
        if (currentAssistantMsgId) {
          // Same turn as the previous assistant event (multi-cycle Claude
          // response) — merge parts into the existing message to mirror the
          // live-streaming merge behavior. Otherwise tool pills get split
          // across N messages and lose their grouping in the UI.
          //
          // Dedupe-on-merge via `upsertParts`: SDK transcript replay after
          // a gate resolution re-emits already-persisted tool_use blocks
          // (same toolCallId). A naive concat duplicates them and, worse,
          // un-promotes any gate part that was promoted in-place
          // (GH#59). `upsertParts` keeps promotion sticky and prevents
          // state regression from terminal states.
          const existing = ctx.session.getMessage(currentAssistantMsgId)
          if (existing) {
            ctx.do.safeUpdateMessage({
              ...existing,
              parts: upsertParts(existing.parts, newParts),
            })
            persisted++
            continue
          }
        }
        // Assistant-side row from a hydrated transcript — bump the assistant
        // ordinal, NOT the user-side turnCounter (which would pre-bump the
        // next user row's id and break the `[turnOrdinal, createdAt]` sort
        // key). See SessionDO.assistantTurnCounter for the full rationale.
        ctx.do.assistantTurnCounter++
        const msgId = `msg-${ctx.do.assistantTurnCounter}`
        const sessionMsg: SessionMessage = {
          id: msgId,
          role: 'assistant',
          parts: newParts,
          createdAt: new Date(),
        }
        await ctx.do.safeAppendMessage(sessionMsg, lastMsgId)
        lastMsgId = msgId
        currentAssistantMsgId = msgId
        persisted++
      } else if (msg.type === 'tool_result') {
        // Apply tool results to the last assistant message
        if (lastMsgId) {
          const existing = ctx.session.getMessage(lastMsgId)
          if (existing) {
            const updatedParts = applyToolResult(existing.parts, msg)
            ctx.do.safeUpdateMessage({ ...existing, parts: updatedParts })
          }
        }
        persisted++
      }
    }
    if (persisted > 0) {
      ctx.do.persistTurnState()
    }
    console.log(
      `[SessionDO:${ctx.ctx.id}] Hydrated ${persisted} new events (skipped ${skipped} existing) from gateway for runner_session=${ctx.state.runner_session_id.slice(0, 12)}`,
    )
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Gateway hydration error:`, err)
  }
}
