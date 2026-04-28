import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock holder for Bun.spawn
const spawnMock = vi.hoisted(() => {
  const spawn = vi.fn()
  return { spawn }
})

vi.mock('bun', () => ({
  spawn: spawnMock.spawn,
}))

// NOTE: GeminiCliAdapter uses the global `Bun.spawn` (not an import from 'bun').
// We patch the global before importing the adapter.
;(globalThis as unknown as { Bun: { spawn: typeof spawnMock.spawn } }).Bun = {
  spawn: spawnMock.spawn,
}

import { GeminiCliAdapter } from './gemini.js'
import type { AdapterStartOptions } from './types.js'

interface RecordedEvent {
  [k: string]: unknown
  type: string
}

/** Build a fake Subprocess whose stdout yields the given JSONL lines. */
function buildFakeSubprocess(jsonlLines: string[], exitCode = 0) {
  const encoder = new TextEncoder()
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of jsonlLines) {
        controller.enqueue(encoder.encode(line + '\n'))
      }
      controller.close()
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      c.close()
    },
  })
  const exited = Promise.resolve(exitCode)
  return {
    stdout,
    stderr,
    exited,
    kill: vi.fn(),
  }
}

function buildOpts(overrides: Partial<AdapterStartOptions> = {}): {
  opts: AdapterStartOptions
  events: RecordedEvent[]
  abort: AbortController
} {
  const events: RecordedEvent[] = []
  const abort = new AbortController()
  const opts: AdapterStartOptions = {
    sessionId: 'sess-gem-1',
    project: '/tmp/test-project',
    model: 'auto-gemini-3',
    prompt: 'Reply with only the word PONG.',
    env: { GEMINI_API_KEY: 'test-key' },
    signal: abort.signal,
    onEvent: (e) => events.push(e as RecordedEvent),
    geminiModels: [{ name: 'auto-gemini-3', context_window: 1_000_000 }],
    ...overrides,
  }
  return { opts, events, abort }
}

beforeEach(() => {
  spawnMock.spawn.mockReset()
})

describe('GeminiCliAdapter', () => {
  it('gemini-adapter-capabilities: matches spec capability bitmap', () => {
    const adapter = new GeminiCliAdapter()
    const caps = adapter.capabilities
    expect(caps).toMatchObject({
      supportsRewind: false,
      supportsThinkingDeltas: false,
      supportsPermissionGate: false,
      supportsSubagents: false,
      supportsPermissionMode: false,
      supportsSetModel: false,
      supportsContextUsage: true,
      supportsInterrupt: true,
      supportsCleanAbort: false,
      emitsUsdCost: false,
    })
  })

  it('gemini-adapter-execute: text-only fixture — session.init, partial_assistant, result with context_usage', async () => {
    const adapter = new GeminiCliAdapter()
    const lines = [
      '{"type":"init","session_id":"84e9cbbd-4523-451a-b957-f0c12e7a0681","model":"auto-gemini-3"}',
      '{"type":"message","role":"user","content":"Reply with only the word PONG."}',
      '{"type":"message","role":"assistant","content":"PONG","delta":true}',
      '{"type":"result","status":"success","stats":{"total_tokens":13681,"input_tokens":13522,"output_tokens":32,"duration_ms":3231}}',
    ]
    const fake = buildFakeSubprocess(lines)
    spawnMock.spawn.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts()
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    // session.init
    const init = events.find((e) => e.type === 'session.init')
    expect(init).toBeDefined()
    expect(init).toMatchObject({
      session_id: 'sess-gem-1',
      runner_session_id: '84e9cbbd-4523-451a-b957-f0c12e7a0681',
      model: 'auto-gemini-3',
      tools: [],
    })
    expect(
      (init as { capabilities: { supportsRewind: boolean } }).capabilities.supportsRewind,
    ).toBe(false)

    // partial_assistant for delta text
    const partial = events.find((e) => e.type === 'partial_assistant')
    expect(partial).toBeDefined()
    expect((partial as { content: Array<{ delta: string }> }).content[0].delta).toBe('PONG')

    // user echo NOT emitted
    expect(events.some((e) => e.type === 'message')).toBe(false)

    // result with context_usage
    const result = events.find((e) => e.type === 'result') as
      | { context_usage: { total_tokens: number; max_tokens: number; percentage: number } }
      | undefined
    expect(result).toBeDefined()
    expect(result?.context_usage.total_tokens).toBe(13681)
    expect(result?.context_usage.max_tokens).toBe(1_000_000)
    expect(result?.context_usage.percentage).toBeCloseTo(0.013681, 5)

    // state transitions
    const states = events
      .filter((e) => e.type === 'session_state_changed')
      .map((e) => (e as { state: string }).state)
    expect(states).toContain('running')
    expect(states).toContain('idle')
  })

  it('gemini-adapter-user-echo-filtered: message{role:user} events are not emitted', async () => {
    const adapter = new GeminiCliAdapter()
    const lines = [
      '{"type":"init","session_id":"aaa","model":"auto-gemini-3"}',
      '{"type":"message","role":"user","content":"hello"}',
      '{"type":"result","status":"success","stats":{"total_tokens":100,"input_tokens":90,"output_tokens":10}}',
    ]
    const fake = buildFakeSubprocess(lines)
    spawnMock.spawn.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts({ prompt: 'hello' })
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    // No partial_assistant for user echo
    expect(events.some((e) => e.type === 'partial_assistant')).toBe(false)
    // No error
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('gemini-adapter-delta-accumulation: multiple delta events accumulate into single assistant', async () => {
    const adapter = new GeminiCliAdapter()
    const lines = [
      '{"type":"init","session_id":"bbb","model":"auto-gemini-3"}',
      '{"type":"message","role":"assistant","content":"It printed","delta":true}',
      '{"type":"message","role":"assistant","content":" HELLO.","delta":true}',
      '{"type":"result","status":"success","stats":{"total_tokens":50,"input_tokens":40,"output_tokens":10}}',
    ]
    const fake = buildFakeSubprocess(lines)
    spawnMock.spawn.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts()
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    // Two partial_assistant events
    const partials = events.filter((e) => e.type === 'partial_assistant')
    expect(partials.length).toBe(2)

    // One assistant event with accumulated text blocks
    const assistant = events.find((e) => e.type === 'assistant') as
      | { content: Array<{ type: string; text: string }> }
      | undefined
    expect(assistant).toBeDefined()
    const textBlocks = assistant?.content.filter((b) => b.type === 'text') ?? []
    expect(textBlocks.map((b) => b.text).join('')).toBe('It printed HELLO.')
  })

  it('gemini-adapter-tool-call: tool_use + tool_result events produce correct gateway events', async () => {
    const adapter = new GeminiCliAdapter()
    const lines = [
      '{"type":"init","session_id":"ccc","model":"auto-gemini-3"}',
      '{"type":"message","role":"assistant","content":"Running...","delta":true}',
      '{"type":"tool_use","tool_name":"run_shell_command","tool_id":"5fxxflvh","parameters":{"command":"echo HELLO"}}',
      '{"type":"tool_result","tool_id":"5fxxflvh","status":"success"}',
      '{"type":"message","role":"assistant","content":"Done.","delta":true}',
      '{"type":"result","status":"success","stats":{"total_tokens":200,"input_tokens":180,"output_tokens":20}}',
    ]
    const fake = buildFakeSubprocess(lines)
    spawnMock.spawn.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts()
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    // tool_result gateway event
    const toolResult = events.find((e) => e.type === 'tool_result') as
      | { content: Array<{ toolCallId: string; toolName: string; status: string }> }
      | undefined
    expect(toolResult).toBeDefined()
    expect(toolResult?.content[0].toolCallId).toBe('5fxxflvh')
    expect(toolResult?.content[0].toolName).toBe('run_shell_command')
    expect(toolResult?.content[0].status).toBe('success')

    // Final assistant has text + tool_use content blocks
    const assistant = events.find((e) => e.type === 'assistant') as
      | { content: Array<{ type: string }> }
      | undefined
    expect(assistant).toBeDefined()
    const toolUseBlock = assistant?.content.find((b) => b.type === 'tool_use')
    expect(toolUseBlock).toBeDefined()
  })

  it('gemini-adapter-context-usage: percentage computed correctly', async () => {
    const adapter = new GeminiCliAdapter()
    const lines = [
      '{"type":"init","session_id":"ddd","model":"auto-gemini-3"}',
      '{"type":"result","status":"success","stats":{"total_tokens":13681,"input_tokens":13522,"output_tokens":32}}',
    ]
    const fake = buildFakeSubprocess(lines)
    spawnMock.spawn.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts({
      geminiModels: [{ name: 'auto-gemini-3', context_window: 1_000_000 }],
    })
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    const result = events.find((e) => e.type === 'result') as
      | { context_usage: { percentage: number; max_tokens: number; total_tokens: number } }
      | undefined
    expect(result?.context_usage.max_tokens).toBe(1_000_000)
    expect(result?.context_usage.total_tokens).toBe(13681)
    expect(result?.context_usage.percentage).toBeCloseTo(13681 / 1_000_000, 8)
  })

  it('gemini-adapter-resume: uses geminiSessionId on subsequent spawns', async () => {
    const adapter = new GeminiCliAdapter()
    const lines = [
      '{"type":"init","session_id":"resume-id-123","model":"auto-gemini-3"}',
      '{"type":"message","role":"assistant","content":"Hello again.","delta":true}',
      '{"type":"result","status":"success","stats":{"total_tokens":100,"input_tokens":90,"output_tokens":10}}',
    ]
    const fake = buildFakeSubprocess(lines)
    spawnMock.spawn.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts({ resumeSessionId: 'resume-id-123' })
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    // Check that --resume was included in spawn args
    const spawnCall = spawnMock.spawn.mock.calls[0]
    const args: string[] = spawnCall[0]
    expect(args).toContain('--resume')
    expect(args).toContain('resume-id-123')
  })

  it('gemini-adapter-resume-fallback: non-zero exit with "not found" in stderr emits error with gemini_resume_failed', async () => {
    const adapter = new GeminiCliAdapter()
    const encoder = new TextEncoder()
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('session not found\n'))
        c.close()
      },
    })
    const fake = { stdout, stderr, exited: Promise.resolve(1), kill: vi.fn() }
    spawnMock.spawn.mockReturnValueOnce(fake)

    const { opts, events } = buildOpts({ resumeSessionId: 'gone-session-id' })
    await adapter.run(opts)

    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect(String(err?.error)).toContain('gemini_resume_failed')
  })
})
