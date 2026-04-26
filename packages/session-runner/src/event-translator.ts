import type { WireMessagePart } from '@duraclaw/shared-types'

/**
 * Translate finalized assistant content blocks → WireMessagePart[].
 * Content blocks: { type: 'text', text }, { type: 'thinking', thinking }, { type: 'tool_use', id, name, input }
 */
export function assistantContentToWireParts(content: unknown[]): WireMessagePart[] {
  const parts: WireMessagePart[] = []
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
 * Translate partial_assistant content blocks → WireMessagePart[].
 * Partial blocks have delta fields instead of full text.
 */
export function partialAssistantToWireParts(content: unknown[]): WireMessagePart[] {
  const parts: WireMessagePart[] = []
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
