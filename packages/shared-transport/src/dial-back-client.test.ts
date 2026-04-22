import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BufferedChannel } from './buffered-channel.js'
import { DialBackClient } from './dial-back-client.js'

// Track all created instances for test inspection
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  url: string
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  sent: string[] = []
  closeCalled = false
  private closeListeners: Function[] = []

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closeCalled = true
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

  simulateClose() {
    this.readyState = 3
    this.onclose?.()
    for (const fn of this.closeListeners) fn()
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

describe('DialBackClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    wsInstances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('connects to callbackUrl with token query param', () => {
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'my-secret-token',
      channel,
      onCommand: () => {},
    })

    client.start()

    expect(wsInstances.length).toBe(1)
    expect(wsInstances[0].url).toContain('wss://example.com/ws')
    expect(wsInstances[0].url).toContain('token=my-secret-token')
  })

  it('backoff sequence for 10 consecutive drops', () => {
    const states: string[] = []
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
      onStateChange: (s) => states.push(s),
    })

    client.start()

    const expectedDelays = [1000, 3000, 9000, 27000, 30000, 30000, 30000, 30000, 30000, 30000]

    for (let i = 0; i < 10; i++) {
      const ws = wsInstances[wsInstances.length - 1]
      // Simulate immediate close (never opened)
      ws.simulateClose()

      // Advance by the expected delay to trigger reconnect
      vi.advanceTimersByTime(expectedDelays[i])
    }

    // Should have created 1 initial + 10 reconnects = 11 WS instances
    expect(wsInstances.length).toBe(11)
  })

  it('backoff resets after 10s healthy connection', () => {
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
    })

    client.start()

    // Open and keep alive for 11 seconds
    const ws1 = wsInstances[0]
    ws1.simulateOpen()
    vi.advanceTimersByTime(11_000)

    // Now drop
    ws1.simulateClose()

    // First reconnect should be at 1000ms (attempt reset to 0)
    const countBefore = wsInstances.length
    vi.advanceTimersByTime(1000)
    expect(wsInstances.length).toBe(countBefore + 1)
  })

  it('routes incoming messages to onCommand', () => {
    const commands: unknown[] = []
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: (cmd) => commands.push(cmd),
    })

    client.start()
    const ws = wsInstances[0]
    ws.simulateOpen()
    ws.simulateMessage({ type: 'execute', worktree: 'dev1' })

    expect(commands.length).toBe(1)
    expect(commands[0]).toEqual({ type: 'execute', worktree: 'dev1' })
  })

  it('collision replaces old WS', () => {
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
    })

    client.start()
    const ws1 = wsInstances[0]
    ws1.simulateOpen()

    // Start again — collision
    client.start()
    expect(ws1.closeCalled).toBe(true)
    expect(wsInstances.length).toBe(2)
  })

  it('emits structured reconnect logs with sessionId via injected logger', () => {
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() }
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
      sessionId: 'sid-1',
      logger,
    })

    client.start()

    const expectedDelays = [1000, 3000, 9000, 27000]
    for (let i = 0; i < expectedDelays.length; i++) {
      const ws = wsInstances[wsInstances.length - 1]
      ws.simulateClose()
      vi.advanceTimersByTime(expectedDelays[i])
    }

    const reconnectLogs = info.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('[dial-back-client] reconnect'))

    expect(reconnectLogs.length).toBe(4)
    expect(reconnectLogs[0]).toContain('attempt=1')
    expect(reconnectLogs[0]).toContain('delay_ms=1000')
    expect(reconnectLogs[0]).toContain('sessionId=sid-1')
    expect(reconnectLogs[1]).toContain('attempt=2')
    expect(reconnectLogs[1]).toContain('delay_ms=3000')
    expect(reconnectLogs[2]).toContain('attempt=3')
    expect(reconnectLogs[2]).toContain('delay_ms=9000')
    expect(reconnectLogs[3]).toContain('attempt=4')
    expect(reconnectLogs[3]).toContain('delay_ms=27000')
  })

  it('emits connection established + dropped logs', () => {
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() }
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
      sessionId: 'sid-2',
      logger,
    })

    client.start()
    const ws = wsInstances[0]
    ws.simulateOpen()

    const establishedLogs = info.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('connection established'))
    expect(establishedLogs.length).toBe(1)
    expect(establishedLogs[0]).toContain('sessionId=sid-2')
    expect(establishedLogs[0]).toContain('first=true')

    ws.simulateClose()
    const droppedLogs = info.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('connection dropped'))
    expect(droppedLogs.length).toBe(1)
    expect(droppedLogs[0]).toContain('sessionId=sid-2')
  })

  // ── GH#57: keepalive tests ─────────────────────────────────────

  it('sends keepalive frames every 25s after connection opens', () => {
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
    })

    client.start()
    const ws = wsInstances[0]
    ws.simulateOpen()

    // No keepalive yet
    expect(ws.sent.filter((s) => s.includes('keepalive')).length).toBe(0)

    // After 25s, first keepalive
    vi.advanceTimersByTime(25_000)
    expect(ws.sent.filter((s) => s.includes('keepalive')).length).toBe(1)
    expect(ws.sent[ws.sent.length - 1]).toBe('{"type":"keepalive"}')

    // After another 25s, second keepalive
    vi.advanceTimersByTime(25_000)
    expect(ws.sent.filter((s) => s.includes('keepalive')).length).toBe(2)
  })

  it('clears keepalive on close and does not send during reconnect', () => {
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
    })

    client.start()
    const ws = wsInstances[0]
    ws.simulateOpen()

    // Get one keepalive
    vi.advanceTimersByTime(25_000)
    const sentBefore = ws.sent.filter((s) => s.includes('keepalive')).length
    expect(sentBefore).toBe(1)

    // Close the WS
    ws.simulateClose()

    // Advance past several keepalive intervals — no more keepalives on old WS
    vi.advanceTimersByTime(100_000)
    expect(ws.sent.filter((s) => s.includes('keepalive')).length).toBe(sentBefore)
  })

  it('clears keepalive on stop()', () => {
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
    })

    client.start()
    const ws = wsInstances[0]
    ws.simulateOpen()

    client.stop()

    // Advance past keepalive interval — nothing sent after stop
    vi.advanceTimersByTime(50_000)
    expect(ws.sent.filter((s) => s.includes('keepalive')).length).toBe(0)
  })

  it('stop() closes WS and prevents reconnect', () => {
    const states: string[] = []
    const channel = new BufferedChannel()
    const client = new DialBackClient({
      callbackUrl: 'wss://example.com/ws',
      bearer: 'tok',
      channel,
      onCommand: () => {},
      onStateChange: (s) => states.push(s),
    })

    client.start()
    const ws = wsInstances[0]
    ws.simulateOpen()

    client.stop()

    expect(ws.closeCalled).toBe(true)
    expect(states[states.length - 1]).toBe('closed')

    // Advance time — no new WS should be created
    const countAfterStop = wsInstances.length
    vi.advanceTimersByTime(60_000)
    expect(wsInstances.length).toBe(countAfterStop)
  })
})
