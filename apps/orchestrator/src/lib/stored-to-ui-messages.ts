import type { UIMessage } from 'ai'
import type { StoredMessage } from '~/lib/types'

/**
 * Convert stored messages (from SQLite) to AI SDK UIMessage format.
 *
 * StoredMessage format:
 *   - user: { content: string }
 *   - assistant: { content: [{ type: 'text', text }, { type: 'tool_use', id, name, input }] }
 *   - tool (tool_result): { uuid: string, content: unknown[] }
 */
export function storedToUIMessages(stored: StoredMessage[]): UIMessage[] {
  const messages: UIMessage[] = []
  // Track tool results by uuid so we can pair them with assistant tool_use blocks
  const toolResults = new Map<string, unknown>()

  // First pass: collect tool results
  for (const msg of stored) {
    if (msg.type === 'tool_result') {
      const data = JSON.parse(msg.data) as { uuid?: string; content?: unknown }
      if (data.uuid) {
        toolResults.set(data.uuid, data.content)
      }
    }
  }

  // Second pass: build UIMessage array
  for (const msg of stored) {
    if (msg.role === 'user') {
      const data = JSON.parse(msg.data) as { content?: string }
      messages.push({
        id: `stored-${msg.id}`,
        role: 'user',
        parts: [{ type: 'text', text: data.content ?? '' }],
      })
    } else if (msg.type === 'assistant') {
      const data = JSON.parse(msg.data) as {
        content?: Array<{
          type: string
          text?: string
          id?: string
          name?: string
          input?: unknown
        }>
      }
      const parts: UIMessage['parts'] = []

      for (const block of data.content ?? []) {
        if (block.type === 'text' && block.text) {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'tool_use' && block.id) {
          const output = toolResults.get(block.id)
          parts.push({
            type: 'dynamic-tool',
            toolName: block.name ?? 'unknown',
            toolCallId: block.id,
            state: output !== undefined ? 'output-available' : 'input-available',
            input: block.input,
            ...(output !== undefined ? { output } : {}),
          } as UIMessage['parts'][number])
        }
      }

      if (parts.length > 0) {
        messages.push({
          id: `stored-${msg.id}`,
          role: 'assistant',
          parts,
        })
      }
    }
    // tool_result messages are consumed via the toolResults map above
  }

  return messages
}
