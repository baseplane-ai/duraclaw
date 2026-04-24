import { describe, expect, it } from 'vitest'
import {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  isAssistantContentEmpty,
  mergeFinalAssistantParts,
  partialAssistantToParts,
  upsertParts,
  upsertToolPart,
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

  it('emits streaming text + reasoning parts, ignores other block types', () => {
    const content = [
      { type: 'thinking', delta: 'hmm' },
      { type: 'text', delta: 'hello' },
      { type: 'tool_use', input_delta: '{"a":' },
    ]
    const parts = partialAssistantToParts(content)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'hmm', state: 'streaming' })
    expect(parts[1]).toEqual({ type: 'text', text: 'hello', state: 'streaming' })
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

  it('preserves a structured ask_user output when tool_result brings a flat string', () => {
    // resolveGate stamps { answers: [...] } so the UI renders a paired Q/A
    // grid. The SDK's AskUserQuestion tool emits a flattened text
    // tool_result afterwards — overwriting the structured output collapses
    // the UI to the legacy single-line fallback.
    const existing = [
      {
        type: 'tool-AskUserQuestion',
        toolCallId: 'tc-ask',
        toolName: 'AskUserQuestion',
        state: 'output-available',
        input: {
          questions: [
            { question: 'Which color?', header: 'color', options: [], multiSelect: false },
          ],
        },
        output: { answers: [{ label: 'Blue' }] },
      },
    ]
    const event = {
      content: [{ tool_use_id: 'tc-ask', content: 'Blue', is_error: false }],
    }
    const result = applyToolResult(existing, event)
    expect(result[0].state).toBe('output-available')
    expect(result[0].output).toEqual({ answers: [{ label: 'Blue' }] })
  })

  it('also preserves structured output for the promoted tool-ask_user type', () => {
    const existing = [
      {
        type: 'tool-ask_user',
        toolCallId: 'tc-ask',
        toolName: 'ask_user',
        state: 'output-available',
        input: {
          questions: [{ question: 'Which size?', header: 'size', options: [], multiSelect: false }],
        },
        output: { answers: [{ label: 'Small', note: 'prefer tight' }] },
      },
    ]
    const event = {
      content: [{ tool_use_id: 'tc-ask', content: 'Small (note: prefer tight)' }],
    }
    const result = applyToolResult(existing, event)
    expect(result[0].output).toEqual({
      answers: [{ label: 'Small', note: 'prefer tight' }],
    })
  })

  it('still overwrites ask_user output when nothing structured was stored', () => {
    // Legacy path / resume-replay path: the part has no structured answer
    // object yet, so the tool_result string is the authoritative display
    // text. Only skip the overwrite when we'd actually lose structure.
    const existing = [
      {
        type: 'tool-AskUserQuestion',
        toolCallId: 'tc-ask',
        toolName: 'AskUserQuestion',
        state: 'input-available',
        input: { questions: [] },
      },
    ]
    const event = {
      content: [{ tool_use_id: 'tc-ask', content: 'some answer' }],
    }
    const result = applyToolResult(existing, event)
    expect(result[0].state).toBe('output-available')
    expect(result[0].output).toBe('some answer')
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

/**
 * Regression-guard suite for "preserve streamed reasoning text on assistant
 * finalize" (commit 02589e3). A silent regression here re-introduces empty
 * reasoning chips because the SDK's final `assistant` event often omits
 * thinking blocks (they only arrive via partial_assistant deltas).
 */
describe('mergeFinalAssistantParts', () => {
  it('returns finalParts when there are no existing parts', () => {
    const finalParts = [{ type: 'text', text: 'hello', state: 'done' as const }]
    expect(mergeFinalAssistantParts(undefined, finalParts)).toEqual(finalParts)
  })

  it('transitions streaming parts to done in place', () => {
    const existing = [
      { type: 'text', text: 'streamed', state: 'streaming' as const },
      { type: 'reasoning', text: 'thought', state: 'streaming' as const },
    ]
    const result = mergeFinalAssistantParts(existing, [])
    expect(result[0].state).toBe('done')
    expect(result[0].text).toBe('streamed')
    expect(result[1].state).toBe('done')
    expect(result[1].text).toBe('thought')
  })

  it('drops final-event reasoning when a streaming reasoning part already existed', () => {
    // The silent-fail scenario: SDK emits thinking only via deltas; final event
    // has no thinking block. Pre-fix code stripped streaming parts and only
    // kept newParts — reasoning text was lost. Post-fix, existing survives.
    const existing = [
      { type: 'reasoning', text: 'accumulated via deltas', state: 'streaming' as const },
      { type: 'text', text: 'partial answer', state: 'streaming' as const },
    ]
    const finalParts = [
      { type: 'text', text: 'partial answer', state: 'done' as const },
      // Note: no reasoning in finalParts — this is the exact regression case.
    ]
    const result = mergeFinalAssistantParts(existing, finalParts)
    // Accumulated reasoning survives.
    expect(result.some((p) => p.type === 'reasoning' && p.text === 'accumulated via deltas')).toBe(
      true,
    )
    // Text appears exactly once (streamed copy kept, final duplicate dropped).
    const textParts = result.filter((p) => p.type === 'text')
    expect(textParts).toHaveLength(1)
    expect(textParts[0].state).toBe('done')
  })

  it('appends final reasoning when no streaming reasoning existed', () => {
    const existing = [{ type: 'text', text: 'answer', state: 'streaming' as const }]
    const finalParts = [
      { type: 'text', text: 'answer', state: 'done' as const },
      { type: 'reasoning', text: 'final thought', state: 'done' as const },
    ]
    const result = mergeFinalAssistantParts(existing, finalParts)
    // Reasoning from final appended because no streaming reasoning existed.
    expect(result.some((p) => p.type === 'reasoning' && p.text === 'final thought')).toBe(true)
  })

  it('preserves input-available tool parts untouched for later tool_result merge', () => {
    const existing = [
      {
        type: 'tool-Bash',
        toolCallId: 't1',
        toolName: 'Bash',
        input: { command: 'ls' },
        state: 'input-available' as const,
      },
    ]
    const result = mergeFinalAssistantParts(existing, [])
    expect(result[0].state).toBe('input-available')
  })
})

// GH#59 — ask_user replay duplication regression guard
describe('upsertToolPart', () => {
  it('appends parts that have no toolCallId', () => {
    const existing = [{ type: 'text', text: 'hi', state: 'done' as const }]
    const incoming = { type: 'reasoning', text: 'thought', state: 'done' as const }
    const out = upsertToolPart(existing, incoming)
    expect(out).toEqual([...existing, incoming])
  })

  it('appends when no existing part matches the toolCallId', () => {
    const existing = [
      {
        type: 'tool-Bash',
        toolCallId: 'tc-a',
        toolName: 'Bash',
        input: {},
        state: 'input-available' as const,
      },
    ]
    const incoming = {
      type: 'tool-Read',
      toolCallId: 'tc-b',
      toolName: 'Read',
      input: { path: '/x' },
      state: 'input-available' as const,
    }
    const out = upsertToolPart(existing, incoming)
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual(incoming)
  })

  it('upserts in place (does not grow the array) when the toolCallId matches', () => {
    const existing = [
      {
        type: 'tool-Bash',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        input: { command: 'ls' },
        state: 'input-available' as const,
      },
    ]
    const incoming = {
      type: 'tool-Bash',
      toolCallId: 'tc-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      state: 'output-available' as const,
      output: 'file.txt',
    }
    const out = upsertToolPart(existing, incoming)
    expect(out).toHaveLength(1)
    expect(out[0].state).toBe('output-available')
    expect(out[0].output).toBe('file.txt')
  })

  it('keeps the promoted gate type when replay re-introduces the SDK-original name', () => {
    // Simulates: `promoteToolPartToGate` has already flipped this part from
    // `tool-AskUserQuestion` to `tool-ask_user`. Then transcript replay
    // re-emits the original `tool_use` block with name `AskUserQuestion`.
    // The promotion must stick — otherwise the client falls back to a pill.
    const existing = [
      {
        type: 'tool-ask_user',
        toolCallId: 'tc-gate',
        toolName: 'ask_user',
        input: { questions: [{ question: 'ok?' }] },
        state: 'approval-requested' as const,
      },
    ]
    const incoming = {
      type: 'tool-AskUserQuestion',
      toolCallId: 'tc-gate',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'ok?' }] },
      state: 'input-available' as const,
    }
    const out = upsertToolPart(existing, incoming)
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('tool-ask_user')
    expect(out[0].toolName).toBe('AskUserQuestion') // toolName from incoming wins
  })

  it('does not regress a terminal output state back to input-available', () => {
    // Simulates: tool already produced a result; replay emits the
    // pre-result input-available shape. The terminal state must win.
    const existing = [
      {
        type: 'tool-Bash',
        toolCallId: 'tc-done',
        toolName: 'Bash',
        input: { command: 'ls' },
        state: 'output-available' as const,
        output: 'x.txt',
      },
    ]
    const incoming = {
      type: 'tool-Bash',
      toolCallId: 'tc-done',
      toolName: 'Bash',
      input: { command: 'ls' },
      state: 'input-available' as const,
    }
    const out = upsertToolPart(existing, incoming)
    expect(out).toHaveLength(1)
    expect(out[0].state).toBe('output-available')
    expect(out[0].output).toBe('x.txt')
  })

  it('does not regress a resolved gate (approval-given) back to approval-requested', () => {
    const existing = [
      {
        type: 'tool-ask_user',
        toolCallId: 'tc-gate',
        toolName: 'ask_user',
        input: { questions: [] },
        state: 'approval-given' as const,
        output: 'Red',
      },
    ]
    const incoming = {
      type: 'tool-AskUserQuestion',
      toolCallId: 'tc-gate',
      toolName: 'AskUserQuestion',
      input: { questions: [] },
      state: 'approval-requested' as const,
    }
    const out = upsertToolPart(existing, incoming)
    expect(out[0].state).toBe('approval-given')
    expect(out[0].type).toBe('tool-ask_user')
    expect(out[0].output).toBe('Red')
  })
})

describe('upsertParts', () => {
  it('collapses a full transcript-replay sequence to zero duplicates', () => {
    // Exact shape of the GH#59 regression: after Round 1 gate resolves, the
    // SDK replays the earlier tool_use blocks. Pre-fix this concat produced
    // 13 parts; post-fix the dedupe collapses it to the unique set.
    const existing = [
      { type: 'reasoning', text: 'thought', state: 'done' as const },
      { type: 'text', text: 'intro', state: 'done' as const },
      {
        type: 'tool-ToolSearch',
        toolCallId: 'tc-search',
        toolName: 'ToolSearch',
        input: {},
        state: 'output-available' as const,
        output: 'ok',
      },
      {
        type: 'tool-Bash',
        toolCallId: 'tc-bash',
        toolName: 'Bash',
        input: { command: 'ls' },
        state: 'output-available' as const,
        output: 'x',
      },
      { type: 'text', text: 'asking', state: 'done' as const },
      {
        type: 'tool-ask_user',
        toolCallId: 'tc-gate',
        toolName: 'ask_user',
        input: { questions: [] },
        state: 'output-available' as const,
        output: 'Red',
      },
    ]
    const replayed = [
      { type: 'text', text: 'intro', state: 'done' as const }, // duplicate text appended
      {
        type: 'tool-ToolSearch',
        toolCallId: 'tc-search',
        toolName: 'ToolSearch',
        input: {},
        state: 'input-available' as const,
      },
      {
        type: 'tool-Bash',
        toolCallId: 'tc-bash',
        toolName: 'Bash',
        input: { command: 'ls' },
        state: 'input-available' as const,
      },
      { type: 'text', text: 'asking', state: 'done' as const }, // duplicate text appended
      {
        type: 'tool-AskUserQuestion',
        toolCallId: 'tc-gate',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        state: 'output-available' as const,
      },
    ]

    const merged = upsertParts(existing, replayed)

    // Tool parts with known toolCallIds must NOT grow: 3 unique ids.
    const toolCallIds = merged.map((p) => p.toolCallId).filter(Boolean)
    expect(toolCallIds.length).toBe(new Set(toolCallIds).size)
    expect(toolCallIds.sort()).toEqual(['tc-bash', 'tc-gate', 'tc-search'])

    // Terminal states held; promoted gate type held.
    const gate = merged.find((p) => p.toolCallId === 'tc-gate')!
    expect(gate.type).toBe('tool-ask_user')
    expect(gate.state).toBe('output-available')
    const bash = merged.find((p) => p.toolCallId === 'tc-bash')!
    expect(bash.state).toBe('output-available')
    expect(bash.output).toBe('x')
  })
})

describe('isAssistantContentEmpty', () => {
  it('treats an empty content array as empty', () => {
    expect(isAssistantContentEmpty([])).toBe(true)
  })

  it('treats a single ZWS-only text block as empty (runaway-loop signature)', () => {
    expect(isAssistantContentEmpty([{ type: 'text', text: '\u200B' }])).toBe(true)
  })

  it('treats whitespace-only text as empty', () => {
    expect(isAssistantContentEmpty([{ type: 'text', text: '   \n\t  ' }])).toBe(true)
  })

  it('treats thinking-only, no substantive text content as empty', () => {
    // Pathological: thinking block with only whitespace + no other blocks.
    expect(isAssistantContentEmpty([{ type: 'thinking', thinking: '  ' }])).toBe(true)
  })

  it('treats a substantive text block as non-empty', () => {
    expect(isAssistantContentEmpty([{ type: 'text', text: 'Hello' }])).toBe(false)
  })

  it('treats a tool_use block as non-empty even with empty sibling text', () => {
    const content = [
      { type: 'text', text: '' },
      { type: 'tool_use', id: 'tc-1', name: 'Bash', input: {} },
    ]
    expect(isAssistantContentEmpty(content)).toBe(false)
  })

  it('treats substantive thinking as non-empty', () => {
    const content = [{ type: 'thinking', thinking: 'The user asked...' }]
    expect(isAssistantContentEmpty(content)).toBe(false)
  })

  it('treats unknown block types as non-empty (conservative — never interrupt unrecognised turns)', () => {
    expect(isAssistantContentEmpty([{ type: 'server_tool_use', id: 'x' }])).toBe(false)
    expect(isAssistantContentEmpty([{ type: 'image', source: {} }])).toBe(false)
  })

  it('empty text + empty thinking together is still empty', () => {
    const content = [
      { type: 'text', text: '\u200B' },
      { type: 'thinking', thinking: '' },
    ]
    expect(isAssistantContentEmpty(content)).toBe(true)
  })
})
