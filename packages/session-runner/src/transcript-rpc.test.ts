/**
 * GH#119 P1.2: WsTranscriptRpc unit tests — multiplexer in isolation.
 *
 * Inject fake `setTimer` / `clearTimer` so timeouts are deterministic and
 * fake the `send` callable so we can inspect outgoing frames without
 * booting a real WS or BufferedChannel.
 */

import { describe, expect, it, vi } from 'vitest'
import { WsTranscriptRpc } from './transcript-rpc'

interface FakeTimer {
  fn: () => void
  ms: number
  cleared: boolean
}

function makeFakeTimers(): {
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
  timers: FakeTimer[]
  fire: (idx: number) => void
} {
  const timers: FakeTimer[] = []
  const setTimer = ((fn: () => void, ms: number) => {
    const t: FakeTimer = { fn, ms, cleared: false }
    timers.push(t)
    return t as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  const clearTimer = ((handle: unknown) => {
    const t = handle as FakeTimer
    if (t) t.cleared = true
  }) as unknown as typeof clearTimeout
  const fire = (idx: number) => {
    const t = timers[idx]
    if (!t) throw new Error(`no timer at index ${idx}`)
    if (t.cleared) throw new Error(`timer at index ${idx} already cleared`)
    t.fn()
  }
  return { setTimer, clearTimer, timers, fire }
}

describe('WsTranscriptRpc', () => {
  it('single call round-trip — sends frame, resolves on handleResponse', async () => {
    const send = vi.fn()
    const { setTimer, clearTimer } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, { setTimer, clearTimer })

    const promise = rpc.call<null>('appendTranscript', { x: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    const frame = send.mock.calls[0][0] as Record<string, unknown>
    const rpcId = frame.rpc_id as string

    rpc.handleResponse(rpcId, null, null)
    await expect(promise).resolves.toBeNull()
    expect(rpc.pendingCount).toBe(0)
  })

  it('wire format — frame has type/method/params/rpc_id/session_id', () => {
    const send = vi.fn()
    const { setTimer, clearTimer } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-abc', send, { setTimer, clearTimer })

    void rpc.call('appendTranscript', { foo: 'bar' })

    expect(send).toHaveBeenCalledTimes(1)
    const frame = send.mock.calls[0][0] as Record<string, unknown>
    expect(frame.type).toBe('transcript-rpc')
    expect(frame.method).toBe('appendTranscript')
    expect(frame.params).toEqual({ foo: 'bar' })
    expect(frame.session_id).toBe('sess-abc')
    expect(typeof frame.rpc_id).toBe('string')
    expect((frame.rpc_id as string).length).toBeGreaterThan(0)
  })

  it('concurrent calls correlate by rpc_id — out-of-order responses each resolve correctly', async () => {
    const send = vi.fn()
    const { setTimer, clearTimer } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, { setTimer, clearTimer })

    const p1 = rpc.call<{ a: number }>('appendTranscript', { i: 1 })
    const p2 = rpc.call<{ b: number }>('loadTranscript', { i: 2 })

    expect(send).toHaveBeenCalledTimes(2)
    const id1 = (send.mock.calls[0][0] as Record<string, unknown>).rpc_id as string
    const id2 = (send.mock.calls[1][0] as Record<string, unknown>).rpc_id as string
    expect(id1).not.toBe(id2)

    // Respond out of order: id2 first, then id1.
    rpc.handleResponse(id2, { b: 22 }, null)
    rpc.handleResponse(id1, { a: 11 }, null)

    await expect(p1).resolves.toEqual({ a: 11 })
    await expect(p2).resolves.toEqual({ b: 22 })
    expect(rpc.pendingCount).toBe(0)
  })

  it('error response — rejects with TranscriptRpc error: <reason>', async () => {
    const send = vi.fn()
    const { setTimer, clearTimer } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, { setTimer, clearTimer })

    const promise = rpc.call('loadTranscript', {})
    const rpcId = (send.mock.calls[0][0] as Record<string, unknown>).rpc_id as string

    rpc.handleResponse(rpcId, null, 'boom')

    await expect(promise).rejects.toThrow('TranscriptRpc error: boom')
    expect(rpc.pendingCount).toBe(0)
  })

  it('late response is dropped silently — unknown rpc_id is a no-op', () => {
    const send = vi.fn()
    const { setTimer, clearTimer } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, { setTimer, clearTimer })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => rpc.handleResponse('no-such-id', { ok: true }, null)).not.toThrow()
    expect(() => rpc.handleResponse('also-missing', null, 'oops')).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('timeout — pending call rejects with timeout message naming the method', async () => {
    const send = vi.fn()
    const { setTimer, clearTimer, fire, timers } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, {
      setTimer,
      clearTimer,
      timeoutMs: 30_000,
    })

    const promise = rpc.call('appendTranscript', { x: 1 })
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(30_000)

    fire(0)

    await expect(promise).rejects.toThrow(/timeout/)
    await expect(promise).rejects.toThrow(/appendTranscript/)
    expect(rpc.pendingCount).toBe(0)
  })

  it('per-call timeoutMs overrides the constructor default — timer scheduled with override window', async () => {
    const send = vi.fn()
    const { setTimer, clearTimer, fire, timers } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, {
      setTimer,
      clearTimer,
      timeoutMs: 30_000,
    })

    const promise = rpc.call('loadTranscript', { x: 1 }, { timeoutMs: 120_000 })
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(120_000)

    fire(0)
    await expect(promise).rejects.toThrow(/timeout/)
    await expect(promise).rejects.toThrow(/loadTranscript/)
    await expect(promise).rejects.toThrow(/120000ms/)
    expect(rpc.pendingCount).toBe(0)
  })

  it('cancelAll(reason) rejects all pending; subsequent handleResponse is silent', async () => {
    const send = vi.fn()
    const { setTimer, clearTimer } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, { setTimer, clearTimer })

    const p1 = rpc.call('appendTranscript', { i: 1 })
    const p2 = rpc.call('loadTranscript', { i: 2 })
    const id1 = (send.mock.calls[0][0] as Record<string, unknown>).rpc_id as string
    const id2 = (send.mock.calls[1][0] as Record<string, unknown>).rpc_id as string

    rpc.cancelAll('ws-closed')

    await expect(p1).rejects.toThrow('TranscriptRpc cancelled: ws-closed')
    await expect(p2).rejects.toThrow('TranscriptRpc cancelled: ws-closed')
    expect(rpc.pendingCount).toBe(0)

    // Late responses for cancelled rpc_ids are silently dropped.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => rpc.handleResponse(id1, { late: true }, null)).not.toThrow()
    expect(() => rpc.handleResponse(id2, null, 'late-err')).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("resolved entries don't leak — cancelAll after resolve cancels nothing", async () => {
    const send = vi.fn()
    const { setTimer, clearTimer, timers } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, { setTimer, clearTimer })

    const promise = rpc.call<string>('loadTranscript', {})
    const rpcId = (send.mock.calls[0][0] as Record<string, unknown>).rpc_id as string

    rpc.handleResponse(rpcId, 'ok', null)
    await expect(promise).resolves.toBe('ok')
    expect(rpc.pendingCount).toBe(0)
    // Timer should have been cleared on resolve.
    expect(timers[0].cleared).toBe(true)

    // cancelAll after resolve should be a no-op — no spurious unhandled rejection.
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    rpc.cancelAll('ws-closed')
    await new Promise((r) => setImmediate(r))
    process.off('unhandledRejection', unhandled)

    expect(rpc.pendingCount).toBe(0)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('synchronous send failure — rejects immediately and clears timer', async () => {
    const send = vi.fn(() => {
      throw new Error('ws not open')
    })
    const { setTimer, clearTimer, timers } = makeFakeTimers()
    const rpc = new WsTranscriptRpc('sess-1', send, { setTimer, clearTimer })

    const promise = rpc.call('appendTranscript', {})
    await expect(promise).rejects.toThrow('ws not open')
    expect(rpc.pendingCount).toBe(0)
    expect(timers[0].cleared).toBe(true)
  })
})
