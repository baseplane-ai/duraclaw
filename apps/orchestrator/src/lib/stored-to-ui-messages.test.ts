import { describe, it, expect } from 'vitest'
import { storedToUIMessages } from './stored-to-ui-messages'
import type { StoredMessage } from './types'

function makeStored(overrides: Partial<StoredMessage> & { id: number; role: StoredMessage['role']; type: string; data: string }): StoredMessage {
  return {
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  }
}

describe('storedToUIMessages', () => {
  it('converts user messages to UIMessage with text part', () => {
    const stored: StoredMessage[] = [
      makeStored({ id: 1, role: 'user', type: 'user-message', data: JSON.stringify({ content: 'hello' }) }),
    ]

    const result = storedToUIMessages(stored)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('converts assistant messages with text blocks', () => {
    const stored: StoredMessage[] = [
      makeStored({
        id: 2,
        role: 'assistant',
        type: 'assistant',
        data: JSON.stringify({
          content: [
            { type: 'text', text: 'Hello! How can I help?' },
          ],
        }),
      }),
    ]

    const result = storedToUIMessages(stored)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
    expect(result[0].parts[0]).toEqual({ type: 'text', text: 'Hello! How can I help?' })
  })

  it('converts assistant tool_use blocks paired with tool_result', () => {
    const stored: StoredMessage[] = [
      makeStored({
        id: 1,
        role: 'assistant',
        type: 'assistant',
        data: JSON.stringify({
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/foo.ts' } },
          ],
        }),
      }),
      makeStored({
        id: 2,
        role: 'tool',
        type: 'tool_result',
        data: JSON.stringify({ uuid: 'tool-1', content: [{ type: 'text', text: 'file contents' }] }),
      }),
    ]

    const result = storedToUIMessages(stored)
    expect(result).toHaveLength(1) // Only assistant message, tool_result is merged

    const assistantMsg = result[0]
    expect(assistantMsg.parts).toHaveLength(2)

    // Text part
    expect(assistantMsg.parts[0]).toEqual({ type: 'text', text: 'Let me check.' })

    // Tool part with output merged from tool_result
    const toolPart = assistantMsg.parts[1] as any
    expect(toolPart.type).toBe('dynamic-tool')
    expect(toolPart.toolName).toBe('Read')
    expect(toolPart.toolCallId).toBe('tool-1')
    expect(toolPart.state).toBe('output-available')
    expect(toolPart.output).toEqual([{ type: 'text', text: 'file contents' }])
  })

  it('marks tool parts without results as input-available', () => {
    const stored: StoredMessage[] = [
      makeStored({
        id: 1,
        role: 'assistant',
        type: 'assistant',
        data: JSON.stringify({
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
          ],
        }),
      }),
      // No tool_result for tool-2
    ]

    const result = storedToUIMessages(stored)
    const toolPart = result[0].parts[0] as any
    expect(toolPart.state).toBe('input-available')
    expect(toolPart.output).toBeUndefined()
  })

  it('handles empty stored messages', () => {
    expect(storedToUIMessages([])).toEqual([])
  })

  it('handles user message with missing content', () => {
    const stored: StoredMessage[] = [
      makeStored({ id: 1, role: 'user', type: 'user-message', data: JSON.stringify({}) }),
    ]

    const result = storedToUIMessages(stored)
    expect(result[0].parts[0]).toEqual({ type: 'text', text: '' })
  })

  it('preserves message ordering', () => {
    const stored: StoredMessage[] = [
      makeStored({ id: 1, role: 'user', type: 'user-message', data: JSON.stringify({ content: 'first' }) }),
      makeStored({
        id: 2,
        role: 'assistant',
        type: 'assistant',
        data: JSON.stringify({ content: [{ type: 'text', text: 'response' }] }),
      }),
      makeStored({ id: 3, role: 'user', type: 'user-message', data: JSON.stringify({ content: 'second' }) }),
    ]

    const result = storedToUIMessages(stored)
    expect(result).toHaveLength(3)
    expect(result[0].role).toBe('user')
    expect(result[1].role).toBe('assistant')
    expect(result[2].role).toBe('user')
  })
})
