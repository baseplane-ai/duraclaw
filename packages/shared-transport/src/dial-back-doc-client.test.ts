import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BufferedChannel } from './buffered-channel.js'
import { DialBackDocClient } from './dial-back-doc-client.js'

// Track all created instances for test inspection. Mirrors the harness in
// dial-back-client.test.ts but accepts binary payloads as well as strings.
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  url: string
  readyState = 0 // CONNECTING
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  sent: unknown[] = []
  closeCalled = false
  closeArgs: { code?: number; reason?: string }[] = []
  private closeListeners: Function[] = []

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closeCalled = true
    this.closeArgs.push({ code, reason })
    this.readyState = 3
    for (const fn of this.closeListeners) fn()
  }

  addEventListener(event: string, handler: Function) {
    if (event === 'close') this.closeListeners.push(handler)
  }

  removeEventListener() {}

  // Test helpers
  simulateOpen() {
    this.readyState = 1
    this.onopen?.()
  }

  /** Simulate a close with optional code/reason — mirrors the WS spec
   * `CloseEvent` fields the parent's `onclose` reads (`code`, `reason`). */
  simulateClose(code?: number, reason?: string) {
    this.readyState = 3
    // Parent reads `e.code` / `e.reason` directly off the event arg.
    ;(this.onclose as unknown as ((e: { code?: number; reason?: string }) => void) | null)?.({
      code,
      reason,
    })
    for (const fn of this.closeListeners) fn()
  }

  /** Simulate an inbound binary frame — passes the data as-is so we can
   * assert on the binaryType-driven parse path. */
  simulateBinaryMessage(data: ArrayBuffer | Uint8Array) {
    const buf = data instanceof Uint8Array ? data.buffer : data
    this.onmessage?.({ data: buf })
  }
}

describe('DialBackDocClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    wsInstances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('round-trips binary frames: send() emits binary, inbound is Uint8Array', () => {
    const received: unknown[] = []
    const channel = new BufferedChannel()
    const client = new DialBackDocClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: (frame) => received.push(frame),
    })

    client.start()
    const ws = wsInstances[0]
    expect(ws.binaryType).toBe('arraybuffer')

    ws.simulateOpen()

    // Outbound: send() must hand the Uint8Array straight to ws.send (no
    // JSON.stringify, no BufferedChannel detour).
    const outbound = new Uint8Array([0x01, 0x02, 0xff, 0x10])
    const ok = client.send(outbound)
    expect(ok).toBe(true)
    expect(ws.sent.length).toBe(1)
    expect(ws.sent[0]).toBe(outbound)
    // Critical regression guard: must NOT have been JSON-stringified.
    expect(typeof ws.sent[0]).not.toBe('string')

    // Inbound: server delivers raw ArrayBuffer; client must surface a
    // Uint8Array view (NOT a string, NOT a parsed JSON object).
    const inbound = new Uint8Array([0xab, 0xcd, 0xef])
    ws.simulateBinaryMessage(inbound)

    expect(received.length).toBe(1)
    expect(received[0]).toBeInstanceOf(Uint8Array)
    expect(Array.from(received[0] as Uint8Array)).toEqual([0xab, 0xcd, 0xef])
  })

  it('send() returns false when socket not open (y-protocols resyncs on reconnect)', () => {
    const channel = new BufferedChannel()
    const client = new DialBackDocClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
    })

    client.start()
    const ws = wsInstances[0]
    // readyState still 0 (CONNECTING) — send must no-op.
    const ok = client.send(new Uint8Array([0x01]))
    expect(ok).toBe(false)
    expect(ws.sent.length).toBe(0)
  })

  it('4412 close → onTerminate("document_deleted"); no reconnect', () => {
    const reasons: string[] = []
    const states: string[] = []
    const channel = new BufferedChannel()
    const client = new DialBackDocClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
      onStateChange: (s) => states.push(s),
      onTerminate: (r) => reasons.push(r),
    })

    client.start()
    const ws = wsInstances[0]
    ws.simulateOpen()

    ws.simulateClose(4412, 'document_deleted')

    expect(reasons).toEqual(['document_deleted'])
    expect(states[states.length - 1]).toBe('closed')

    // No reconnect must be scheduled — advance well past every backoff.
    const countBefore = wsInstances.length
    vi.advanceTimersByTime(120_000)
    expect(wsInstances.length).toBe(countBefore)
  })

  it('4401/4410 still terminate with original reasons (regression)', () => {
    for (const [code, expected] of [
      [4401, 'invalid_token'],
      [4410, 'token_rotated'],
    ] as const) {
      const reasons: string[] = []
      const channel = new BufferedChannel()
      const client = new DialBackDocClient({
        callbackUrl: 'wss://example.com/ws',
        bearer: 'tok',
        channel,
        onCommand: () => {},
        onTerminate: (r) => reasons.push(r),
      })

      client.start()
      const ws = wsInstances[wsInstances.length - 1]
      ws.simulateOpen()
      ws.simulateClose(code)

      expect(reasons).toEqual([expected])

      // No reconnect — confirm by advancing past the longest backoff.
      const countBefore = wsInstances.length
      vi.advanceTimersByTime(60_000)
      expect(wsInstances.length).toBe(countBefore)
    }
  })

  it('inherits reconnect backoff on non-terminal close', () => {
    const channel = new BufferedChannel()
    const client = new DialBackDocClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
    })

    client.start()
    expect(wsInstances.length).toBe(1)

    // Non-terminal close (e.g. transient network blip, code 1006).
    wsInstances[0].simulateClose(1006)

    // Parent backoff: first reconnect at 1000ms.
    expect(wsInstances.length).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(wsInstances.length).toBe(2)

    // Second drop → 3000ms.
    wsInstances[1].simulateClose(1006)
    vi.advanceTimersByTime(3000)
    expect(wsInstances.length).toBe(3)
  })
})
