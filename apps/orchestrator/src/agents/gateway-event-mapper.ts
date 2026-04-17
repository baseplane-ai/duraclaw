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
        output: extractToolOutput(b.content),
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
