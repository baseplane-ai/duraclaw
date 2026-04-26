import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted holder so the `vi.mock` factory below and individual tests
// share the same fake `Codex` constructor + `Thread` shape.
const codexMock = vi.hoisted(() => {
  const startThread = vi.fn()
  const resumeThread = vi.fn()
  const ctorCalls: Array<unknown> = []
  class FakeCodex {
    constructor(opts?: unknown) {
      ctorCalls.push(opts)
    }
    startThread = startThread
    resumeThread = resumeThread
  }
  return { FakeCodex, startThread, resumeThread, ctorCalls }
})

vi.mock('@openai/codex-sdk', () => ({
  Codex: codexMock.FakeCodex,
}))

// Import AFTER vi.mock is registered so the adapter sees the fake.
import { CodexAdapter } from './codex.js'
import type { AdapterStartOptions } from './types.js'

interface RecordedEvent {
  [k: string]: unknown
  type: string
}

interface FakeThread {
  id: string | null
  runStreamed: ReturnType<typeof vi.fn>
}

function buildThread(id: string | null, events: unknown[]): FakeThread {
  return {
    id,
    runStreamed: vi.fn(async (_input: string, _opts?: { signal?: AbortSignal }) => ({
      events: (async function* () {
        for (const ev of events) yield ev
      })(),
    })),
  }
}

function buildOpts(
  overrides: Partial<AdapterStartOptions> & { onEvent?: (e: unknown) => void } = {},
): { opts: AdapterStartOptions; events: RecordedEvent[]; abort: AbortController } {
  const events: RecordedEvent[] = []
  const abort = new AbortController()
  const opts: AdapterStartOptions = {
    sessionId: 'sess-1',
    project: '/tmp/test-project',
    model: 'gpt-5.1',
    prompt: 'hello',
    env: { OPENAI_API_KEY: 'test-key' },
    signal: abort.signal,
    onEvent: (e) => events.push(e as RecordedEvent),
    ...overrides,
  }
  return { opts, events, abort }
}

beforeEach(() => {
  codexMock.startThread.mockReset()
  codexMock.resumeThread.mockReset()
  codexMock.ctorCalls.length = 0
})

describe('CodexAdapter', () => {
  it('exposes name "codex" and matches the spec capability bitmap', () => {
    const adapter = new CodexAdapter()
    expect(adapter.name).toBe('codex')
    const caps = adapter.capabilities
    expect(caps).toMatchObject({
      supportsRewind: false,
      supportsThinkingDeltas: false,
      supportsPermissionGate: false,
      supportsSubagents: false,
      supportsPermissionMode: false,
      supportsSetModel: false,
      supportsContextUsage: true,
      supportsInterrupt: false,
      supportsCleanAbort: false,
      emitsUsdCost: false,
    })
    expect(caps.availableProviders).toEqual([
      { provider: 'openai', models: ['gpt-5.1', 'o4-mini'] },
    ])
  })

  it('codex-adapter-execute: starts thread, emits session.init with thread id, partial_assistant on text deltas, and result with context_usage', async () => {
    const adapter = new CodexAdapter()
    const fake = buildThread(null, [
      { type: 'thread.started', thread_id: 'thread-abc' },
      { type: 'turn.started' },
      {
        type: 'item.updated',
        item: { type: 'agent_message', id: 'msg-1', text: 'hello' },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'msg-1', text: 'hello world' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 0,
        },
      },
    ])
    codexMock.startThread.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts({
      codexModels: [{ name: 'gpt-5.1', context_window: 1_000_000 }],
    })
    // Drive run to completion by aborting once the queue is awaiting.
    const runP = adapter.run(opts)
    // Yield to let the first turn finish, then abort to break the await loop.
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    expect(codexMock.ctorCalls.length).toBe(1)
    expect(codexMock.startThread).toHaveBeenCalledWith({
      workingDirectory: '/tmp/test-project',
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      skipGitRepoCheck: true,
    })

    const init = events.find((e) => e.type === 'session.init')
    expect(init).toBeDefined()
    expect(init).toMatchObject({
      session_id: 'sess-1',
      runner_session_id: 'thread-abc',
      project: '/tmp/test-project',
      model: 'gpt-5.1',
      tools: [],
    })
    expect(
      (init as { capabilities: { supportsRewind: boolean } }).capabilities.supportsRewind,
    ).toBe(false)

    const partial = events.find((e) => e.type === 'partial_assistant')
    expect(partial).toBeDefined()

    const final = events.find((e) => e.type === 'assistant')
    expect(final).toMatchObject({ uuid: 'msg-1' })

    const result = events.find((e) => e.type === 'result') as
      | { context_usage: { total_tokens: number; max_tokens: number; percentage: number } }
      | undefined
    expect(result).toBeDefined()
    expect(result?.context_usage.total_tokens).toBe(150)
    expect(result?.context_usage.max_tokens).toBe(1_000_000)
    expect(result?.context_usage.percentage).toBeCloseTo(0.00015, 6)

    const stateEvents = events
      .filter((e) => e.type === 'session_state_changed')
      .map((e) => (e as { state: string }).state)
    expect(stateEvents).toContain('running')
    expect(stateEvents).toContain('idle')
  })

  it('codex-adapter-resume: ResumeCommand path calls codex.resumeThread', async () => {
    const adapter = new CodexAdapter()
    const fake = buildThread('thread-resumed', [
      { type: 'thread.started', thread_id: 'thread-resumed' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'msg-r', text: 'continued' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ])
    codexMock.resumeThread.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts({ resumeSessionId: 'thread-resumed' })
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    expect(codexMock.resumeThread).toHaveBeenCalledWith('thread-resumed')
    expect(codexMock.startThread).not.toHaveBeenCalled()

    const init = events.find((e) => e.type === 'session.init')
    expect(init).toMatchObject({ runner_session_id: 'thread-resumed' })
  })

  it('codex-adapter-resume-fallback: resumeThread throw emits error event and returns', async () => {
    const adapter = new CodexAdapter()
    codexMock.resumeThread.mockImplementationOnce(() => {
      throw new Error('thread file missing')
    })

    const { opts, events } = buildOpts({ resumeSessionId: 'thread-missing' })
    await adapter.run(opts)

    expect(codexMock.resumeThread).toHaveBeenCalledWith('thread-missing')
    // No session.init for a failed resume.
    expect(events.some((e) => e.type === 'session.init')).toBe(false)
    const err = events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect(err?.error).toContain('codex_resume_failed')
    expect(err?.error).toContain('thread file missing')
  })

  it('codex-adapter-context-usage: o4-mini math (60k / 200k = 0.3)', async () => {
    const adapter = new CodexAdapter()
    const fake = buildThread(null, [
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 50_000,
          cached_input_tokens: 0,
          output_tokens: 10_000,
          reasoning_output_tokens: 0,
        },
      },
    ])
    codexMock.startThread.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts({
      model: 'o4-mini',
      codexModels: [{ name: 'o4-mini', context_window: 200_000 }],
    })
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    const result = events.find((e) => e.type === 'result') as
      | {
          context_usage: {
            input_tokens: number
            output_tokens: number
            total_tokens: number
            max_tokens: number
            percentage: number
            model: string
          }
        }
      | undefined
    expect(result?.context_usage).toEqual({
      input_tokens: 50_000,
      output_tokens: 10_000,
      total_tokens: 60_000,
      max_tokens: 200_000,
      percentage: 0.3,
      model: 'o4-mini',
    })
  })

  it('codex-adapter-context-usage: unknown model falls back to 128k and emits a one-time warning', async () => {
    const adapter = new CodexAdapter()
    const fake = buildThread(null, [
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 0,
          output_tokens: 500,
          reasoning_output_tokens: 0,
        },
      },
    ])
    codexMock.startThread.mockReturnValueOnce(fake)

    const { opts, events, abort } = buildOpts({
      model: 'mystery-model',
      codexModels: [{ name: 'gpt-5.1', context_window: 1_000_000 }],
    })
    const runP = adapter.run(opts)
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    await runP

    const warnings = events.filter(
      (e) => e.type === 'error' && String(e.error).includes('Unknown model context window'),
    )
    expect(warnings).toHaveLength(1)
    const result = events.find((e) => e.type === 'result') as
      | { context_usage: { max_tokens: number } }
      | undefined
    expect(result?.context_usage.max_tokens).toBe(128_000)
  })

  it('capabilities reflect codex_models when provided', async () => {
    const adapter = new CodexAdapter()
    // Seed this.opts by running with a pre-aborted signal — run() checks
    // signal.aborted immediately after setting this.opts and returns early.
    const abort = new AbortController()
    abort.abort()
    const fakeOpts: AdapterStartOptions = {
      sessionId: 's',
      project: '/p',
      prompt: '',
      env: { OPENAI_API_KEY: 'test-key' },
      signal: abort.signal,
      onEvent: () => {},
      codexModels: [
        { name: 'a', context_window: 1 },
        { name: 'b', context_window: 2 },
      ],
    }
    // startThread is called before the signal check; give it a minimal fake.
    codexMock.startThread.mockReturnValueOnce(buildThread(null, []))
    await adapter.run(fakeOpts)
    expect(adapter.capabilities.availableProviders).toEqual([
      { provider: 'openai', models: ['a', 'b'] },
    ])
  })
})
