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
 * Map a partial_assistant event to streaming text parts.
 * partial_assistant has content: PartialContentBlock[] with deltas.
 * We accumulate these into a single streaming text part.
 */
export function partialAssistantToParts(content: unknown[]): SessionMessagePart[] {
  const parts: SessionMessagePart[] = []
  for (const block of content) {
    const b = block as Record<string, unknown>
    if (b.type === 'text') {
      parts.push({ type: 'text', text: (b.delta as string) ?? '', state: 'streaming' })
    }
  }
  return parts
}

/**
 * Apply a tool_result event to existing message parts.
 * Finds the matching tool part by toolCallId and updates its state/output.
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
      const isError = b.is_error === true
      updatedParts[idx] = {
        ...updatedParts[idx],
        state: isError ? 'output-error' : 'output-available',
        output: isError ? undefined : b.content,
      }
    }
  }
  return updatedParts
}

/**
 * Finalize any streaming parts to done state.
 * Called when session ends (result/stopped/error) to clean up orphaned streaming.
 */
export function finalizeStreamingParts(parts: SessionMessagePart[]): SessionMessagePart[] {
  return parts.map((p) => (p.state === 'streaming' ? { ...p, state: 'done' } : p))
}
