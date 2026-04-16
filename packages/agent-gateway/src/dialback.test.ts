import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAdapter } from './adapters/types.js'
import { dialbackSessions, dialOutboundWs, handleDialbackMessage } from './dialback.js'
import { ReconnectableChannel, type SessionChannel } from './session-channel.js'
import type { GatewaySessionContext } from './types.js'

/** Create a mock SessionChannel that captures sent messages */
function createMockChannel() {
  const sent: string[] = []
  return {
    ch: {
      send(data: string) {
        sent.push(data)
      },
      close() {},
      readyState: 1,
    } satisfies SessionChannel,
    sent,
    parseLast() {
      return JSON.parse(sent[sent.length - 1])
    },
  }
}

/** Create a mock GatewaySessionContext */
function createMockCtx(overrides?: Partial<GatewaySessionContext>): GatewaySessionContext {
  return {
    sessionId: 'test-session',
    orgId: null,
    userId: null,
    adapterName: null,
    abortController: new AbortController(),
    pendingAnswer: null,
    pendingPermission: null,
    messageQueue: null,
    query: null,
    commandQueue: [],
    ...overrides,
  }
}

afterEach(() => {
  dialbackSessions.clear()
})

describe('handleDialbackMessage', () => {
  describe('stream-input', () => {
    it('pushes message to messageQueue when queue exists', () => {
      const { ch } = createMockChannel()
      const pushFn = vi.fn()
      const ctx = createMockCtx({
        messageQueue: { push: pushFn, waitForNext: vi.fn(), done: vi.fn() },
      })

      handleDialbackMessage(
        's1',
        { type: 'stream-input', message: { role: 'user', content: 'hello' } },
        ctx,
        ch,
      )

      expect(pushFn).toHaveBeenCalledWith({ role: 'user', content: 'hello' })
    })

    it('does nothing when messageQueue is null', () => {
      const { ch } = createMockChannel()
      const ctx = createMockCtx({ messageQueue: null })

      // Should not throw
      handleDialbackMessage(
        's1',
        { type: 'stream-input', message: { role: 'user', content: 'hi' } },
        ctx,
        ch,
      )
    })
  })

  describe('permission-response', () => {
    it('resolves pendingPermission and clears it', () => {
      const { ch } = createMockChannel()
      const resolveFn = vi.fn()
      const ctx = createMockCtx({
        pendingPermission: { resolve: resolveFn, reject: vi.fn() },
      })

      handleDialbackMessage('s1', { type: 'permission-response', allowed: true }, ctx, ch)

      expect(resolveFn).toHaveBeenCalledWith(true)
      expect(ctx.pendingPermission).toBeNull()
    })

    it('resolves with false when not allowed', () => {
      const { ch } = createMockChannel()
      const resolveFn = vi.fn()
      const ctx = createMockCtx({
        pendingPermission: { resolve: resolveFn, reject: vi.fn() },
      })

      handleDialbackMessage('s1', { type: 'permission-response', allowed: false }, ctx, ch)

      expect(resolveFn).toHaveBeenCalledWith(false)
    })

    it('does nothing when no pendingPermission', () => {
      const { ch } = createMockChannel()
      const ctx = createMockCtx({ pendingPermission: null })

      // Should not throw
      handleDialbackMessage('s1', { type: 'permission-response', allowed: true }, ctx, ch)
    })
  })

  describe('abort', () => {
    it('aborts the controller and removes from dialbackSessions', () => {
      const { ch } = createMockChannel()
      const ctx = createMockCtx()
      dialbackSessions.set('s1', { ctx, channel: ch, ws: {} as any })

      handleDialbackMessage('s1', { type: 'abort' }, ctx, ch)

      expect(ctx.abortController.signal.aborted).toBe(true)
      expect(dialbackSessions.has('s1')).toBe(false)
    })
  })

  describe('stop', () => {
    it('aborts, sends stopped event, and removes from dialbackSessions', () => {
      const { ch, parseLast } = createMockChannel()
      const ctx = createMockCtx({ sessionId: 'sdk-123' })
      dialbackSessions.set('s1', { ctx, channel: ch, ws: {} as any })

      handleDialbackMessage('s1', { type: 'stop' }, ctx, ch)

      expect(ctx.abortController.signal.aborted).toBe(true)
      const msg = parseLast()
      expect(msg.type).toBe('stopped')
      expect(msg.session_id).toBe('sdk-123')
      expect(msg.sdk_session_id).toBe('sdk-123')
      expect(dialbackSessions.has('s1')).toBe(false)
    })

    it('tolerates channel.send failure on stop', () => {
      const failChannel: SessionChannel = {
        send() {
          throw new Error('closed')
        },
        close() {},
        readyState: 3,
      }
      const ctx = createMockCtx()
      dialbackSessions.set('s1', { ctx, channel: failChannel, ws: {} as any })

      // Should not throw
      handleDialbackMessage('s1', { type: 'stop' }, ctx, failChannel)

      expect(ctx.abortController.signal.aborted).toBe(true)
      expect(dialbackSessions.has('s1')).toBe(false)
    })
  })

  describe('answer', () => {
    it('resolves pendingAnswer and clears it', () => {
      const { ch } = createMockChannel()
      const resolveFn = vi.fn()
      const ctx = createMockCtx({
        pendingAnswer: { resolve: resolveFn, reject: vi.fn() },
      })

      handleDialbackMessage('s1', { type: 'answer', answers: { q1: 'yes' } }, ctx, ch)

      expect(resolveFn).toHaveBeenCalledWith({ q1: 'yes' })
      expect(ctx.pendingAnswer).toBeNull()
    })

    it('does nothing when no pendingAnswer', () => {
      const { ch } = createMockChannel()
      const ctx = createMockCtx({ pendingAnswer: null })

      // Should not throw
      handleDialbackMessage('s1', { type: 'answer', answers: {} }, ctx, ch)
    })
  })

  describe('query commands (interrupt, get-context-usage, set-model, set-permission-mode)', () => {
    it('queues command when query is null', () => {
      const { ch } = createMockChannel()
      const ctx = createMockCtx({ query: null, commandQueue: [] })

      handleDialbackMessage('s1', { type: 'interrupt', session_id: 's1' }, ctx, ch)

      expect(ctx.commandQueue).toHaveLength(1)
      expect(ctx.commandQueue[0].type).toBe('interrupt')
    })

    it('queues set-model when query is null', () => {
      const { ch } = createMockChannel()
      const ctx = createMockCtx({ query: null, commandQueue: [] })

      handleDialbackMessage('s1', { type: 'set-model', session_id: 's1', model: 'opus' }, ctx, ch)

      expect(ctx.commandQueue).toHaveLength(1)
      expect(ctx.commandQueue[0].type).toBe('set-model')
    })

    it('calls handleQueryCommand when query is available', () => {
      const { ch } = createMockChannel()
      const interruptFn = vi.fn().mockResolvedValue(undefined)
      const ctx = createMockCtx({
        query: { interrupt: interruptFn } as any,
        commandQueue: [],
      })

      handleDialbackMessage('s1', { type: 'interrupt', session_id: 's1' }, ctx, ch)

      // handleQueryCommand is called, which calls query.interrupt()
      expect(interruptFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('rewind', () => {
    it('calls query.rewindFiles and sends rewind_result', async () => {
      const { ch, parseLast } = createMockChannel()
      const rewindResult = {
        canRewind: true,
        error: null,
        filesChanged: 2,
        insertions: 10,
        deletions: 3,
      }
      let resolveRewind!: (v: any) => void
      const rewindPromise = new Promise((r) => {
        resolveRewind = r
      })
      const rewindFilesFn = vi.fn().mockReturnValue(rewindPromise)
      const ctx = createMockCtx({
        sessionId: 'sess-1',
        query: { rewindFiles: rewindFilesFn } as any,
      })

      handleDialbackMessage('s1', { type: 'rewind', message_id: 'msg-1', dry_run: true }, ctx, ch)

      expect(rewindFilesFn).toHaveBeenCalledWith('msg-1', { dryRun: true })

      // Resolve the promise and let microtasks flush
      resolveRewind(rewindResult)
      await rewindPromise
      // Allow .then() handler to run
      await new Promise((r) => setTimeout(r, 0))

      const msg = parseLast()
      expect(msg.type).toBe('rewind_result')
      expect(msg.can_rewind).toBe(true)
      expect(msg.files_changed).toBe(2)
    })

    it('sends error when rewindFiles rejects', async () => {
      const { ch, parseLast } = createMockChannel()
      let rejectRewind!: (e: Error) => void
      const rewindPromise = new Promise((_r, rej) => {
        rejectRewind = rej
      })
      const rewindFilesFn = vi.fn().mockReturnValue(rewindPromise)
      const ctx = createMockCtx({
        sessionId: 'sess-1',
        query: { rewindFiles: rewindFilesFn } as any,
      })

      handleDialbackMessage('s1', { type: 'rewind', message_id: 'msg-1', dry_run: false }, ctx, ch)

      // Reject and let microtasks flush
      rejectRewind(new Error('disk full'))
      await rewindPromise.catch(() => {})
      await new Promise((r) => setTimeout(r, 0))

      const msg = parseLast()
      expect(msg.type).toBe('error')
      expect(msg.error).toContain('disk full')
    })

    it('does nothing when query is null', () => {
      const { ch, sent } = createMockChannel()
      const ctx = createMockCtx({ query: null })

      handleDialbackMessage('s1', { type: 'rewind', message_id: 'msg-1' }, ctx, ch)

      expect(sent).toHaveLength(0)
    })
  })

  describe('stop-task', () => {
    it('calls query.stopTask with the task_id', () => {
      const { ch } = createMockChannel()
      const stopTaskFn = vi.fn()
      const ctx = createMockCtx({
        query: { stopTask: stopTaskFn } as any,
      })

      handleDialbackMessage('s1', { type: 'stop-task', task_id: 'task-42' }, ctx, ch)

      expect(stopTaskFn).toHaveBeenCalledWith('task-42')
    })

    it('does nothing when query is null', () => {
      const { ch } = createMockChannel()
      const ctx = createMockCtx({ query: null })

      // Should not throw
      handleDialbackMessage('s1', { type: 'stop-task', task_id: 'task-42' }, ctx, ch)
    })
  })

  describe('ping', () => {
    it('responds with pong', () => {
      const { ch, parseLast } = createMockChannel()
      const ctx = createMockCtx()

      handleDialbackMessage('s1', { type: 'ping' }, ctx, ch)

      expect(parseLast().type).toBe('pong')
    })

    it('tolerates send failure', () => {
      const failChannel: SessionChannel = {
        send() {
          throw new Error('closed')
        },
        close() {},
        readyState: 3,
      }
      const ctx = createMockCtx()

      // Should not throw
      handleDialbackMessage('s1', { type: 'ping' }, ctx, failChannel)
    })
  })

  describe('unknown message type', () => {
    it('does not throw for unrecognized message types', () => {
      const { ch, sent } = createMockChannel()
      const ctx = createMockCtx()

      // Should not throw
      handleDialbackMessage('s1', { type: 'nonexistent-cmd' }, ctx, ch)
      expect(sent).toHaveLength(0)
    })
  })
})

describe('dialbackSessions map', () => {
  it('is initially empty', () => {
    expect(dialbackSessions.size).toBe(0)
  })

  it('can store and retrieve entries', () => {
    const { ch } = createMockChannel()
    const ctx = createMockCtx()
    dialbackSessions.set('test-id', { ctx, channel: ch, ws: {} as any })

    expect(dialbackSessions.has('test-id')).toBe(true)
    expect(dialbackSessions.get('test-id')?.ctx).toBe(ctx)
  })
})

// ── dialOutboundWs tests ──────────────────────────────────────

/**
 * Controllable mock WebSocket for testing dialOutboundWs.
 * Allows tests to fire open/close/message/error events on demand.
 */
class MockWebSocket {
  static instances: MockWebSocket[] = []
  private listeners = new Map<string, Function[]>()
  readyState = 0 // CONNECTING

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }

  addEventListener(event: string, handler: Function) {
    const list = this.listeners.get(event) ?? []
    list.push(handler)
    this.listeners.set(event, list)
  }

  send = vi.fn()
  close = vi.fn()

  /** Fire an event on this mock WS */
  emit(event: string, data?: any) {
    const handlers = this.listeners.get(event) ?? []
    for (const h of handlers) {
      h(data ?? {})
    }
  }

  /** Simulate the WS opening */
  simulateOpen() {
    this.readyState = 1
    this.emit('open')
  }

  /** Simulate the WS closing */
  simulateClose() {
    this.readyState = 3
    this.emit('close')
  }

  /** Simulate a message from the DO */
  simulateMessage(msg: object) {
    this.emit('message', { data: JSON.stringify(msg) })
  }
}

/** Create a mock adapter that tracks execute/resume calls */
function createMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: 'test',
    execute: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves (long-running)
    resume: vi.fn().mockReturnValue(new Promise(() => {})),
    abort: vi.fn(),
    getCapabilities: vi.fn().mockResolvedValue({
      agent: 'test',
      available: true,
      supportedCommands: [],
      description: 'test adapter',
    }),
    ...overrides,
  }
}

describe('dialOutboundWs', () => {
  let originalWebSocket: typeof globalThis.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = MockWebSocket as any
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
    dialbackSessions.clear()
    vi.restoreAllMocks()
  })

  it('creates a ReconnectableChannel and calls adapter.execute on first connection', () => {
    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')

    expect(MockWebSocket.instances).toHaveLength(1)
    const ws = MockWebSocket.instances[0]

    // Simulate connection open
    ws.simulateOpen()

    // Should have registered in dialbackSessions
    expect(dialbackSessions.has('sess-1')).toBe(true)
    const entry = dialbackSessions.get('sess-1')!
    expect(entry.channel).toBeInstanceOf(ReconnectableChannel)

    // Should have called adapter.execute (not resume)
    expect(adapter.execute).toHaveBeenCalledTimes(1)
    expect(adapter.resume).not.toHaveBeenCalled()

    // The channel passed to adapter.execute should be the ReconnectableChannel
    const passedChannel = (adapter.execute as any).mock.calls[0][0]
    expect(passedChannel).toBe(entry.channel)
  })

  it('calls adapter.resume when cmd.type is resume', () => {
    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = {
      type: 'resume' as const,
      project: 'test',
      prompt: 'continue',
      sdk_session_id: 'sdk-1',
    }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')
    MockWebSocket.instances[0].simulateOpen()

    expect(adapter.resume).toHaveBeenCalledTimes(1)
    expect(adapter.execute).not.toHaveBeenCalled()
  })

  it('does NOT re-execute adapter on reconnect (attempt > 0)', () => {
    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }
    const existingChannel = new ReconnectableChannel({
      send: vi.fn(),
      close: vi.fn(),
      readyState: 3,
    } as any)

    // Simulate reconnect (attempt=1 with existingChannel)
    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1', 1, existingChannel)
    MockWebSocket.instances[0].simulateOpen()

    // Adapter should NOT be called again
    expect(adapter.execute).not.toHaveBeenCalled()
    expect(adapter.resume).not.toHaveBeenCalled()

    // Session should be re-registered in dialbackSessions
    expect(dialbackSessions.has('sess-1')).toBe(true)
    // The channel should be the same existingChannel (not a new one)
    expect(dialbackSessions.get('sess-1')!.channel).toBe(existingChannel)
  })

  it('calls replaceWebSocket on reconnect to swap the underlying WS', () => {
    const mockWs = { send: vi.fn(), close: vi.fn(), readyState: 3 } as any
    const existingChannel = new ReconnectableChannel(mockWs)
    const replaceSpy = vi.spyOn(existingChannel, 'replaceWebSocket')

    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1', 1, existingChannel)

    const newWs = MockWebSocket.instances[0]
    newWs.simulateOpen()

    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(replaceSpy).toHaveBeenCalledWith(newWs)
  })

  it('schedules reconnect on close when session is active and not aborted', () => {
    vi.useFakeTimers()

    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()

    // Simulate WS drop
    ws1.simulateClose()

    // Should schedule a reconnect (1s for attempt 0)
    expect(MockWebSocket.instances).toHaveLength(1) // not yet

    vi.advanceTimersByTime(1000)

    // A new WebSocket should have been created for reconnect
    expect(MockWebSocket.instances).toHaveLength(2)
    const ws2 = MockWebSocket.instances[1]
    expect(ws2.url).toBe('wss://example.com/ws')

    vi.useRealTimers()
  })

  it('passes existingChannel through reconnect attempts so adapter is never re-executed', () => {
    vi.useFakeTimers()

    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    // First connection
    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()

    expect(adapter.execute).toHaveBeenCalledTimes(1)

    // Drop and reconnect
    ws1.simulateClose()
    vi.advanceTimersByTime(1000)

    const ws2 = MockWebSocket.instances[1]
    ws2.simulateOpen()

    // adapter.execute should still only have been called once (from the first connection)
    expect(adapter.execute).toHaveBeenCalledTimes(1)

    // The channel in dialbackSessions should be a ReconnectableChannel
    const entry = dialbackSessions.get('sess-1')
    expect(entry).toBeDefined()
    expect(entry!.channel).toBeInstanceOf(ReconnectableChannel)

    vi.useRealTimers()
  })

  it('aborts session after max retries exhausted', () => {
    vi.useFakeTimers()

    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')
    MockWebSocket.instances[0].simulateOpen()

    // Drop and reconnect 3 times (max retries = 3)
    for (let i = 0; i < 3; i++) {
      MockWebSocket.instances[MockWebSocket.instances.length - 1].simulateClose()
      vi.advanceTimersByTime(3 ** i * 1000)
      MockWebSocket.instances[MockWebSocket.instances.length - 1].simulateOpen()
    }

    // Now the 4th close should trigger abort (attempt 3 >= maxRetries 3)
    MockWebSocket.instances[MockWebSocket.instances.length - 1].simulateClose()
    vi.advanceTimersByTime(30_000) // plenty of time

    expect(ctx.abortController.signal.aborted).toBe(true)
    expect(dialbackSessions.has('sess-1')).toBe(false)

    vi.useRealTimers()
  })

  it('does not reconnect when abortController is already aborted', () => {
    vi.useFakeTimers()

    const ctx = createMockCtx()
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')
    MockWebSocket.instances[0].simulateOpen()

    // Abort the session, then close WS
    ctx.abortController.abort()
    MockWebSocket.instances[0].simulateClose()

    vi.advanceTimersByTime(10_000)

    // No reconnect should have happened
    expect(MockWebSocket.instances).toHaveLength(1)

    vi.useRealTimers()
  })

  it('routes messages through the channel from dialbackSessions', () => {
    const ctx = createMockCtx({
      pendingAnswer: { resolve: vi.fn(), reject: vi.fn() },
    })
    const adapter = createMockAdapter()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')
    MockWebSocket.instances[0].simulateOpen()

    // Simulate a message from DO
    MockWebSocket.instances[0].simulateMessage({ type: 'answer', answers: { q1: 'yes' } })

    // Should have resolved the pending answer
    expect(ctx.pendingAnswer).toBeNull()
  })

  it('cleans up dialbackSessions when adapter promise resolves', async () => {
    let resolveSession!: () => void
    const sessionPromise = new Promise<void>((r) => {
      resolveSession = r
    })
    const adapter = createMockAdapter({
      execute: vi.fn().mockReturnValue(sessionPromise),
    })

    const ctx = createMockCtx()
    const cmd = { type: 'execute' as const, project: 'test', prompt: 'hello' }

    dialOutboundWs('wss://example.com/ws', cmd as any, ctx, adapter, 'sess-1')
    MockWebSocket.instances[0].simulateOpen()

    expect(dialbackSessions.has('sess-1')).toBe(true)

    // Resolve the adapter session
    resolveSession()
    await sessionPromise
    // Let .finally() run
    await new Promise((r) => setTimeout(r, 0))

    expect(dialbackSessions.has('sess-1')).toBe(false)
  })
})
