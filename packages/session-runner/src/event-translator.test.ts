import { describe, expect, it } from 'vitest'
import { assistantContentToWireParts, partialAssistantToWireParts } from './event-translator'

describe('event-translator', () => {
  describe('assistantContentToWireParts', () => {
    it('converts text content block to WireMessagePart with type=text (event-translator-text)', () => {
      const content = [{ type: 'text', text: 'Hello world' }]
      const parts = assistantContentToWireParts(content)
      expect(parts).toEqual([{ type: 'text', text: 'Hello world', state: 'done' }])
    })

    it('converts thinking block to WireMessagePart with type=reasoning (event-translator-thinking)', () => {
      const content = [{ type: 'thinking', thinking: 'Let me think...' }]
      const parts = assistantContentToWireParts(content)
      expect(parts).toEqual([{ type: 'reasoning', text: 'Let me think...', state: 'done' }])
    })

    it('converts tool_use block with toolCallId, toolName, input, state=input-available (event-translator-tool-use)', () => {
      const content = [{ type: 'tool_use', id: 'tc-1', name: 'Read', input: { path: '/foo' } }]
      const parts = assistantContentToWireParts(content)
      expect(parts).toEqual([
        {
          type: 'tool-Read',
          toolCallId: 'tc-1',
          toolName: 'Read',
          input: { path: '/foo' },
          state: 'input-available',
        },
      ])
    })

    it('maps mixed content blocks in order', () => {
      const content = [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'tc-2', name: 'Bash', input: { cmd: 'ls' } },
      ]
      const parts = assistantContentToWireParts(content)
      expect(parts).toHaveLength(3)
      expect(parts[0].type).toBe('reasoning')
      expect(parts[1].type).toBe('text')
      expect(parts[2].type).toBe('tool-Bash')
    })

    it('skips unknown block types', () => {
      expect(assistantContentToWireParts([{ type: 'image', data: 'x' }])).toEqual([])
    })

    it('handles empty array', () => {
      expect(assistantContentToWireParts([])).toEqual([])
    })
  })

  describe('partialAssistantToWireParts', () => {
    it('converts text delta to streaming text part', () => {
      const content = [{ type: 'text', delta: 'partial text' }]
      const parts = partialAssistantToWireParts(content)
      expect(parts).toEqual([{ type: 'text', text: 'partial text', state: 'streaming' }])
    })

    it('converts thinking delta to streaming reasoning part (event-translator-thinking)', () => {
      const content = [{ type: 'thinking', delta: 'hmm' }]
      const parts = partialAssistantToWireParts(content)
      expect(parts).toEqual([{ type: 'reasoning', text: 'hmm', state: 'streaming' }])
    })

    it('uses empty string when delta is missing', () => {
      const content = [{ type: 'text' }]
      const parts = partialAssistantToWireParts(content)
      expect(parts).toEqual([{ type: 'text', text: '', state: 'streaming' }])
    })

    it('ignores non-text/thinking blocks', () => {
      const content = [
        { type: 'text', delta: 'hi' },
        { type: 'tool_use', input_delta: '{"a":' },
      ]
      const parts = partialAssistantToWireParts(content)
      expect(parts).toHaveLength(1)
    })

    it('handles empty array', () => {
      expect(partialAssistantToWireParts([])).toEqual([])
    })
  })
})
