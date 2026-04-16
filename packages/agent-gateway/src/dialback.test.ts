import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialbackSessions, handleDialbackMessage } from './dialback.js'
import type { SessionChannel } from './session-channel.js'
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
