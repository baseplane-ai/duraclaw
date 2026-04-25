import type { SessionMessagePart } from 'agents/experimental/memory/session'

/**
 * Map a finalized assistant event's content blocks to SessionMessageParts.
 * Content blocks come from the gateway as: { type: 'text', text }, { type: 'thinking', thinking }, { type: 'tool_use', id, name, input }
 */
export function assistantContentToParts(content: unknown[]): SessionMessagePart[] {
  const parts: SessionMessagePart[] = []
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b.type === 'text') {
      parts.push({ type: 'text', text: b.text as string, state: 'done' })
    } else if (b.type === 'thinking') {
      parts.push({ type: 'reasoning', text: b.thinking as string, state: 'done' })
    } else if (b.type === 'tool_use') {
      parts.push({
        type: `tool-${b.name as string}`,
        toolCallId: b.id as string,
        toolName: b.name as string,
        input: b.input,
        state: 'input-available',
      })
    }
  }
  return parts
}

/**
 * Map a partial_assistant event to streaming parts.
 * partial_assistant has content: PartialContentBlock[] with deltas.
 * Text blocks become streaming text parts; thinking blocks become streaming
 * reasoning parts so extended-thinking traces render live alongside the
 * assistant response.
 */
export function partialAssistantToParts(content: unknown[]): SessionMessagePart[] {
  const parts: SessionMessagePart[] = []
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b.type === 'text') {
      parts.push({ type: 'text', text: (b.delta as string) ?? '', state: 'streaming' })
    } else if (b.type === 'thinking') {
      parts.push({ type: 'reasoning', text: (b.delta as string) ?? '', state: 'streaming' })
    }
  }
  return parts
}

/**
 * Predicate — true when a finalized `assistant` event's content is
 * "effectively empty": no tool_use blocks, and every text/thinking block
 * has only whitespace / zero-width characters. Used by
 * `SessionDO.case 'assistant'` to detect the runaway-turn failure mode
 * where Claude stops emitting substantive content and spins on a loop
 * of single-ZWS assistant turns (prod incident 2026-04-24, session
 * `sess-ffca0374-...`, 500+ single-char persisted parts before user
 * interrupt).
 *
 * Conservative by design:
 * - Empty `content: []` → empty (the SDK occasionally emits these on
 *   transcript replay / cancellation paths, which is exactly what we
 *   want the runaway counter to catch).
 * - Any `tool_use` block → non-empty (tool calls always count as
 *   progress, even if paired with whitespace text).
 * - Any text/thinking block with non-whitespace content → non-empty.
 *   Note: `String.prototype.trim()` does NOT strip U+200B / U+200C /
 *   U+200D / U+FEFF (ZWS / ZWNJ / ZWJ / BOM) — which is exactly the
 *   character the runaway-loop model emits. `IS_BLANK_RE` adds those to
 *   the standard `\s` class so a single-ZWS turn counts as empty.
 * - Unknown block types (image, server_tool_use, etc.) → non-empty.
 *   Unknown shapes are treated as progress so we never interrupt a
 *   legitimate turn we simply don't recognise.
 */
const IS_BLANK_RE = /^[\s\u200B-\u200D\uFEFF]*$/

export function isAssistantContentEmpty(content: unknown[]): boolean {
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b.type === 'tool_use') return false
    if (b.type === 'text') {
      if (typeof b.text === 'string' && !IS_BLANK_RE.test(b.text)) return false
      continue
    }
    if (b.type === 'thinking') {
      if (typeof b.thinking === 'string' && !IS_BLANK_RE.test(b.thinking)) return false
      continue
    }
    // Unknown block type — treat as progress.
    return false
  }
  return true
}

/**
 * Extract displayable text from tool result content.
 * Content can be a string, an array of content blocks [{type:"text", text:"..."}], or other shapes.
 */
function extractToolOutput(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return undefined
}

/**
 * Apply a tool_result event to existing message parts.
 * Finds the matching tool part by toolCallId and updates its state/output.
 *
 * Special case for ask_user gates: `resolveGate` stores the answer as a
 * structured `{ answers: StructuredAnswer[] }` object so the UI can render
 * a paired Q/A grid. The SDK's AskUserQuestion tool subsequently emits a
 * flat text tool_result — overwriting the structured output with that
 * string collapses the UI into the legacy single-line "flat answer"
 * fallback. Keep the structured output intact; only advance `state`.
 */
export function applyToolResult(
  existingParts: SessionMessagePart[],
  event: { content: unknown[] },
): SessionMessagePart[] {
  const updatedParts = [...existingParts]
  for (const block of event.content) {
    const b = block as Record<string, unknown>
    const toolUseId = b.tool_use_id as string | undefined
    if (!toolUseId) continue

    const idx = updatedParts.findIndex((p) => p.toolCallId === toolUseId)
    if (idx !== -1) {
      const existing = updatedParts[idx]
      const isError = b.is_error === true
      const isAskUserPart =
        existing.type === 'tool-ask_user' || existing.type === 'tool-AskUserQuestion'
      const hasStructuredAnswers =
        existing.output != null &&
        typeof existing.output === 'object' &&
        Array.isArray((existing.output as { answers?: unknown }).answers)

      updatedParts[idx] = {
        ...existing,
        state: isError ? 'output-error' : 'output-available',
        output:
          isAskUserPart && hasStructuredAnswers ? existing.output : extractToolOutput(b.content),
      }
    }
  }
  return updatedParts
}

/**
 * Finalize any streaming parts to done state.
 * Called when session ends (result/stopped/error) to clean up orphaned streaming.
 * Also marks any tool parts still in 'input-available' (waiting for results) as
 * 'output-error' since the connection dropped before they could complete.
 */
export function finalizeStreamingParts(parts: SessionMessagePart[]): SessionMessagePart[] {
  return parts.map((p) => {
    if (p.state === 'streaming') return { ...p, state: 'done' }
    if (p.state === 'input-available')
      return { ...p, state: 'output-error', output: 'Connection lost — tool did not complete' }
    return p
  })
}

/**
 * Terminal tool-part states that must never be regressed by a replay. Once a
 * tool has an output or an approval decision, the SDK's later re-emission of
 * the same tool_use block (transcript replay on continuation) must not wipe
 * that state back to `input-available` / `approval-requested`.
 */
const TERMINAL_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
  'approval-given',
  'approval-denied',
])

/**
 * Gate-part types that the SessionDO promotes to from the SDK-original
 * `tool-AskUserQuestion` / `tool-*Permission*` shapes via
 * `promoteToolPartToGate`. When a replayed part for the same toolCallId
 * arrives with the SDK-original type, the promotion must stick — otherwise
 * the UI falls back to a pill and the gate becomes invisible.
 */
const PROMOTED_GATE_TYPES = new Set(['tool-ask_user', 'tool-permission'])

/**
 * Upsert a single part into an existing parts array by `toolCallId`.
 *
 * - Parts without a `toolCallId` (text, reasoning, data-*) are always appended.
 * - Parts whose `toolCallId` doesn't match any existing part are appended.
 * - Parts whose `toolCallId` matches an existing part are merged **in place**
 *   rather than appended. Merge rules:
 *     - **Type is sticky to the promoted form.** If the existing part has
 *       already been promoted to `tool-ask_user` / `tool-permission` (by
 *       `promoteToolPartToGate` in session-do), a replayed SDK-original type
 *       (`tool-AskUserQuestion`, etc.) does NOT overwrite it.
 *     - **State never regresses from a terminal state.** Once a tool part is
 *       `output-available` / `output-denied` / `approval-given` /
 *       `approval-denied`, a replayed `input-available` /
 *       `approval-requested` is ignored.
 *     - `toolName`, `input`, and `output` on the incoming part win only when
 *       they are defined; otherwise the existing values are preserved.
 *
 * This is the single source of truth for dedupe-on-append across both the
 * live-streaming assistant handler (`mergeFinalAssistantParts` below) and
 * the hydration-from-gateway path in `SessionDO.hydrateFromGatewayTranscript`.
 */
export function upsertToolPart(
  parts: SessionMessagePart[],
  incoming: SessionMessagePart,
): SessionMessagePart[] {
  if (!incoming.toolCallId) return [...parts, incoming]
  const idx = parts.findIndex((p) => p.toolCallId === incoming.toolCallId)
  if (idx === -1) return [...parts, incoming]

  const existing = parts[idx]
  const keepPromotedType =
    PROMOTED_GATE_TYPES.has(existing.type as string) &&
    !PROMOTED_GATE_TYPES.has(incoming.type as string)
  const existingIsTerminal = TERMINAL_TOOL_STATES.has(existing.state as string)

  const merged: SessionMessagePart = {
    ...existing,
    type: keepPromotedType ? existing.type : (incoming.type ?? existing.type),
    toolName: incoming.toolName ?? existing.toolName,
    toolCallId: existing.toolCallId,
    input: incoming.input ?? existing.input,
    output: incoming.output ?? existing.output,
    state: existingIsTerminal ? existing.state : (incoming.state ?? existing.state),
  }
  const next = [...parts]
  next[idx] = merged
  return next
}

/**
 * Fold a batch of incoming parts into an existing parts array, upserting
 * tool parts by `toolCallId` (see `upsertToolPart`). Non-tool parts (text,
 * reasoning) are appended in order.
 */
export function upsertParts(
  existing: SessionMessagePart[],
  incoming: SessionMessagePart[],
): SessionMessagePart[] {
  let out = existing
  for (const p of incoming) {
    out = upsertToolPart(out, p)
  }
  return out
}

/**
 * Merge the final `assistant` event content with any previously-accumulated
 * streaming parts so delta-accumulated text/reasoning survives finalize.
 *
 * Behavior (regression-guarded):
 * - Streaming parts transition in place (streaming → done) so the delta-accumulated
 *   text/reasoning survives. Tool parts in 'input-available' are left untouched —
 *   tool_result events finalize them next.
 * - If the message had streaming text/reasoning, the matching kind from the final
 *   `assistant` event is dropped (the streamed copy is authoritative — the SDK may
 *   or may not re-emit thinking blocks in the final event).
 * - Tool parts are upserted by toolCallId (see `upsertToolPart`) so transcript
 *   replay after gate resolution cannot re-append already-persisted tool_use
 *   blocks as new parts — that path produced the GH#59 ask_user replay bug.
 * - If no existing parts are supplied, the final event's parts are used directly.
 */
export function mergeFinalAssistantParts(
  existingParts: SessionMessagePart[] | undefined,
  finalParts: SessionMessagePart[],
): SessionMessagePart[] {
  if (!existingParts) return finalParts
  const finalized = existingParts.map((p) =>
    p.state === 'streaming' ? { ...p, state: 'done' as const } : p,
  )
  const hadStreamingText = existingParts.some((p) => p.type === 'text' && p.state === 'streaming')
  const hadStreamingReasoning = existingParts.some(
    (p) => p.type === 'reasoning' && p.state === 'streaming',
  )
  let out = finalized
  for (const np of finalParts) {
    if (np.type === 'text' && hadStreamingText) continue
    if (np.type === 'reasoning' && hadStreamingReasoning) continue
    // Tool parts dedupe by toolCallId; text/reasoning flow through as appends
    // because upsertToolPart treats a missing toolCallId as append.
    out = upsertToolPart(out, np)
  }
  return out
}
