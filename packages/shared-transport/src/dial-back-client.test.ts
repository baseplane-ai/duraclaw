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
