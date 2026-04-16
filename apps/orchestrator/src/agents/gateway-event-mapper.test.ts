import { describe, expect, it } from 'vitest'
import {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  partialAssistantToParts,
} from './gateway-event-mapper'

describe('assistantContentToParts', () => {
  it('maps text blocks to text parts with done state', () => {
    const content = [{ type: 'text', text: 'Hello world' }]
    const parts = assistantContentToParts(content)
    expect(parts).toEqual([{ type: 'text', text: 'Hello world', state: 'done' }])
  })

  it('maps thinking blocks to reasoning parts', () => {
    const content = [{ type: 'thinking', thinking: 'Let me think...' }]
    const parts = assistantContentToParts(content)
    expect(parts).toEqual([{ type: 'reasoning', text: 'Let me think...', state: 'done' }])
  })

  it('maps tool_use blocks to tool parts with input-available state', () => {
    const content = [{ type: 'tool_use', id: 'tc-1', name: 'Read', input: { path: '/foo' } }]
    const parts = assistantContentToParts(content)
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
    const parts = assistantContentToParts(content)
    expect(parts).toHaveLength(3)
    expect(parts[0].type).toBe('reasoning')
    expect(parts[1].type).toBe('text')
    expect(parts[2].type).toBe('tool-Bash')
  })

  it('skips unknown block types', () => {
    const content = [{ type: 'unknown_thing', data: 'ignored' }]
    const parts = assistantContentToParts(content)
    expect(parts).toEqual([])
  })

  it('handles empty content array', () => {
    expect(assistantContentToParts([])).toEqual([])
  })
})

describe('partialAssistantToParts', () => {
  it('maps text blocks with delta to streaming parts', () => {
    const content = [{ type: 'text', delta: 'partial text' }]
    const parts = partialAssistantToParts(content)
    expect(parts).toEqual([{ type: 'text', text: 'partial text', state: 'streaming' }])
  })

  it('uses empty string when delta is missing', () => {
    const content = [{ type: 'text' }]
    const parts = partialAssistantToParts(content)
    expect(parts).toEqual([{ type: 'text', text: '', state: 'streaming' }])
  })

  it('ignores non-text blocks', () => {
    const content = [
      { type: 'thinking', delta: 'ignored' },
      { type: 'text', delta: 'kept' },
    ]
    const parts = partialAssistantToParts(content)
    expect(parts).toHaveLength(1)
    expect(parts[0].text).toBe('kept')
  })

  it('handles empty content array', () => {
    expect(partialAssistantToParts([])).toEqual([])
  })
})

describe('applyToolResult', () => {
  it('updates matching tool part to output-available', () => {
    const existing = [
      { type: 'text', text: 'hello', state: 'done' },
      {
        type: 'tool-Read',
        toolCallId: 'tc-1',
        toolName: 'Read',
        input: { path: '/a' },
        state: 'input-available',
      },
    ]
    const event = {
      content: [{ tool_use_id: 'tc-1', content: 'file contents', is_error: false }],
    }
    const result = applyToolResult(existing, event)
    expect(result[1].state).toBe('output-available')
    expect(result[1].output).toBe('file contents')
  })

  it('sets output-error state when is_error is true', () => {
    const existing = [
      { type: 'tool-Bash', toolCallId: 'tc-2', toolName: 'Bash', state: 'input-available' },
    ]
    const event = {
      content: [{ tool_use_id: 'tc-2', content: 'command failed', is_error: true }],
    }
    const result = applyToolResult(existing, event)
    expect(result[0].state).toBe('output-error')
    // We preserve the output string so the UI can show the error message.
    expect(result[0].output).toBe('command failed')
  })

  it('does not modify parts without matching toolCallId', () => {
    const existing = [
      { type: 'tool-Read', toolCallId: 'tc-1', toolName: 'Read', state: 'input-available' },
    ]
    const event = {
      content: [{ tool_use_id: 'tc-999', content: 'irrelevant' }],
    }
    const result = applyToolResult(existing, event)
    expect(result[0].state).toBe('input-available')
  })

  it('skips content blocks without tool_use_id', () => {
    const existing = [
      { type: 'tool-Read', toolCallId: 'tc-1', toolName: 'Read', state: 'input-available' },
    ]
    const event = {
      content: [{ content: 'no tool_use_id here' }],
    }
    const result = applyToolResult(existing, event)
    expect(result[0].state).toBe('input-available')
  })

  it('does not mutate the original array', () => {
    const existing = [
      { type: 'tool-Read', toolCallId: 'tc-1', toolName: 'Read', state: 'input-available' },
    ]
    const event = {
      content: [{ tool_use_id: 'tc-1', content: 'done' }],
    }
    applyToolResult(existing, event)
    expect(existing[0].state).toBe('input-available')
  })

  it('handles multiple tool results in one event', () => {
    const existing = [
      { type: 'tool-Read', toolCallId: 'tc-1', toolName: 'Read', state: 'input-available' },
      { type: 'tool-Bash', toolCallId: 'tc-2', toolName: 'Bash', state: 'input-available' },
    ]
    const event = {
      content: [
        { tool_use_id: 'tc-1', content: 'result-1' },
        { tool_use_id: 'tc-2', content: 'result-2', is_error: true },
      ],
    }
    const result = applyToolResult(existing, event)
    expect(result[0].state).toBe('output-available')
    expect(result[0].output).toBe('result-1')
    expect(result[1].state).toBe('output-error')
  })
})

describe('finalizeStreamingParts', () => {
  it('changes streaming parts to done', () => {
    const parts = [{ type: 'text', text: 'partial', state: 'streaming' }]
    const result = finalizeStreamingParts(parts)
    expect(result[0].state).toBe('done')
  })

  it('leaves done and output-available parts unchanged', () => {
    const parts = [
      { type: 'text', text: 'complete', state: 'done' },
      { type: 'tool-Read', toolCallId: 'tc-1', state: 'output-available', output: 'file contents' },
    ]
    const result = finalizeStreamingParts(parts)
    expect(result[0].state).toBe('done')
    expect(result[1].state).toBe('output-available')
  })

  it('marks input-available tools as output-error on connection drop', () => {
    const parts = [
      { type: 'text', text: 'running tools', state: 'done' },
      { type: 'tool-Bash', toolCallId: 'tc-1', state: 'input-available' },
      { type: 'tool-Bash', toolCallId: 'tc-2', state: 'input-available' },
    ]
    const result = finalizeStreamingParts(parts)
    expect(result[0].state).toBe('done')
    expect(result[1].state).toBe('output-error')
    expect(result[1].output).toBe('Connection lost — tool did not complete')
    expect(result[2].state).toBe('output-error')
  })

  it('does not mutate the original array', () => {
    const parts = [{ type: 'text', text: 'p', state: 'streaming' }]
    finalizeStreamingParts(parts)
    expect(parts[0].state).toBe('streaming')
  })

  it('handles empty array', () => {
    expect(finalizeStreamingParts([])).toEqual([])
  })

  it('handles mixed streaming and done parts', () => {
    const parts = [
      { type: 'text', text: 'done text', state: 'done' },
      { type: 'text', text: 'streaming text', state: 'streaming' },
      { type: 'reasoning', text: 'thought', state: 'done' },
    ]
    const result = finalizeStreamingParts(parts)
    expect(result[0].state).toBe('done')
    expect(result[1].state).toBe('done')
    expect(result[2].state).toBe('done')
  })
})
