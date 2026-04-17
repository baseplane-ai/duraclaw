import { describe, expect, it, vi } from 'vitest'
import { BufferedChannel, type GapSentinel } from './buffered-channel.js'

class MockWebSocket {
  readyState = 1 // OPEN
  sent: string[] = []
  onclose: (() => void) | null = null
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  addEventListener(event: string, handler: Function) {
    if (event === 'close') this.onclose = handler as any
  }
  removeEventListener() {}
}

describe('BufferedChannel', () => {
  it('buffers events when WS not attached', () => {
    const ch = new BufferedChannel()
    for (let i = 1; i <= 5; i++) {
      ch.send({ seq: i })
    }
    expect(ch.depth).toBe(5)
  })

  it('sends directly when WS attached and open', () => {
    const ch = new BufferedChannel()
    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)
    ch.send({ seq: 1, data: 'hello' })
    expect(ws.sent.length).toBe(1)
    expect(JSON.parse(ws.sent[0])).toEqual({ seq: 1, data: 'hello' })
    expect(ch.depth).toBe(0)
  })

  it('replays buffered events on attach', () => {
    const ch = new BufferedChannel()
    ch.send({ seq: 1 })
    ch.send({ seq: 2 })
    ch.send({ seq: 3 })

    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)

    expect(ws.sent.length).toBe(3)
    expect(JSON.parse(ws.sent[0])).toEqual({ seq: 1 })
    expect(JSON.parse(ws.sent[1])).toEqual({ seq: 2 })
    expect(JSON.parse(ws.sent[2])).toEqual({ seq: 3 })
  })

  it('pushes 15000 events, replays from oldest kept', () => {
    const ch = new BufferedChannel({ maxEvents: 10_000 })

    for (let i = 1; i <= 15_000; i++) {
      ch.send({ seq: i })
    }

    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)

    // First message should be gap sentinel
    const gap = JSON.parse(ws.sent[0]) as GapSentinel
    expect(gap.type).toBe('gap')
    expect(gap.dropped_count).toBe(5000)
    expect(gap.from_seq).toBe(1)
    expect(gap.to_seq).toBe(5000)

    // Then events 5001-15000
    expect(ws.sent.length).toBe(1 + 10_000)
    expect(JSON.parse(ws.sent[1]).seq).toBe(5001)
    expect(JSON.parse(ws.sent[ws.sent.length - 1]).seq).toBe(15_000)
  })

  it('emits single gap sentinel on overflow with correct seq range', () => {
    const gaps: GapSentinel[] = []
    const ch = new BufferedChannel({
      maxEvents: 3,
      onOverflow: (g) => gaps.push({ ...g }),
    })

    for (let i = 1; i <= 5; i++) {
      ch.send({ seq: i })
    }

    // Should have overflow calls, last gap should cover seq 1-2
    const lastGap = gaps[gaps.length - 1]
    expect(lastGap.from_seq).toBe(1)
    expect(lastGap.to_seq).toBe(2)
    expect(lastGap.dropped_count).toBe(2)
    expect(ch.depth).toBe(3)

    // On attach, single gap sentinel sent
    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)

    const sentGap = JSON.parse(ws.sent[0]) as GapSentinel
    expect(sentGap.type).toBe('gap')
    expect(sentGap.dropped_count).toBe(2)
    expect(sentGap.from_seq).toBe(1)
    expect(sentGap.to_seq).toBe(2)
  })

  it('byte-cap overflow drops oldest to stay under maxBytes', () => {
    // Each event serialized ~20 bytes, so set maxBytes small
    const ch = new BufferedChannel({ maxBytes: 100, maxEvents: 10_000 })

    // Push events that will exceed 100 bytes total
    for (let i = 1; i <= 10; i++) {
      ch.send({ seq: i, payload: 'x'.repeat(20) })
    }

    // Buffer should be limited by byte cap
    expect(ch.depth).toBeLessThan(10)

    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)

    // First message should be gap sentinel
    const gap = JSON.parse(ws.sent[0]) as GapSentinel
    expect(gap.type).toBe('gap')
    expect(gap.from_seq).toBe(1)
  })

  it('oversized single event sent directly on live WS', () => {
    const ch = new BufferedChannel({ maxBytes: 50 })
    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)

    // Send event larger than maxBytes
    const bigEvent = { seq: 1, data: 'x'.repeat(200) }
    ch.send(bigEvent)

    expect(ws.sent.length).toBe(1)
    expect(JSON.parse(ws.sent[0]).seq).toBe(1)
  })

  it('oversized single event dropped when WS not attached', () => {
    const overflows: GapSentinel[] = []
    const ch = new BufferedChannel({
      maxBytes: 50,
      onOverflow: (g) => overflows.push({ ...g }),
    })

    const bigEvent = { seq: 1, data: 'x'.repeat(200) }
    ch.send(bigEvent)

    expect(ch.depth).toBe(0)
    expect(overflows.length).toBeGreaterThan(0)
    const lastOverflow = overflows[overflows.length - 1]
    expect(lastOverflow.type).toBe('gap')
    expect(lastOverflow.from_seq).toBe(1)
    expect(lastOverflow.to_seq).toBe(1)
  })

  it('depth metric reflects current queue size', () => {
    const ch = new BufferedChannel()

    ch.send({ seq: 1 })
    ch.send({ seq: 2 })
    ch.send({ seq: 3 })
    expect(ch.depth).toBe(3)

    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)

    // After attach, buffer drained
    expect(ch.depth).toBe(0)
  })

  it('coalesces multiple overflow gaps into single sentinel', () => {
    const ch = new BufferedChannel({ maxEvents: 2 })

    // Push 10 events while disconnected — overflows happen multiple times
    for (let i = 1; i <= 10; i++) {
      ch.send({ seq: i })
    }

    // Only 2 should remain in buffer
    expect(ch.depth).toBe(2)

    const ws = new MockWebSocket()
    ch.attachWebSocket(ws as unknown as WebSocket)

    // First message = single coalesced gap sentinel
    const gap = JSON.parse(ws.sent[0]) as GapSentinel
    expect(gap.type).toBe('gap')
    expect(gap.dropped_count).toBe(8)
    expect(gap.from_seq).toBe(1)
    expect(gap.to_seq).toBe(8)

    // Then 2 buffered events
    expect(ws.sent.length).toBe(3) // 1 gap + 2 events
    expect(JSON.parse(ws.sent[1]).seq).toBe(9)
    expect(JSON.parse(ws.sent[2]).seq).toBe(10)
  })

  it('emits structured overflow log via injected logger with sessionId', () => {
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    const ch = new BufferedChannel({
      maxEvents: 3,
      sessionId: 'abc',
      logger,
    })

    for (let i = 1; i <= 5; i++) {
      ch.send({ seq: i })
    }

    // Two drops happened (seq=1 then seq=2) — both should log.
    expect(warn).toHaveBeenCalled()
    const messages = warn.mock.calls.map((c) => c[0]) as string[]
    // At least one line matching: [buffered-channel] overflow sessionId=abc dropped_count=... from_seq=1 to_seq=...
    expect(messages[0]).toContain('[buffered-channel] overflow sessionId=abc')
    expect(messages[0]).toContain('dropped_count=1')
    expect(messages[0]).toContain('from_seq=1')
    expect(messages[0]).toContain('to_seq=1')

    const lastMsg = messages[messages.length - 1]
    expect(lastMsg).toContain('[buffered-channel] overflow sessionId=abc')
    expect(lastMsg).toContain('dropped_count=2')
    expect(lastMsg).toContain('from_seq=1')
    expect(lastMsg).toContain('to_seq=2')
  })

  it('omits sessionId from log lines when not provided', () => {
    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    const ch = new BufferedChannel({ maxEvents: 1, logger })

    ch.send({ seq: 1 })
    ch.send({ seq: 2 }) // triggers overflow

    expect(warn).toHaveBeenCalled()
    const firstMsg = warn.mock.calls[0][0] as string
    expect(firstMsg).not.toContain('sessionId=')
    expect(firstMsg).toContain('[buffered-channel] overflow')
  })

  it('verbose mode emits send logs with depth', () => {
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() }
    const ch = new BufferedChannel({ sessionId: 'xyz', logger, verbose: true })

    ch.send({ seq: 1 })
    ch.send({ seq: 2 })

    expect(info).toHaveBeenCalledTimes(2)
    const msg1 = info.mock.calls[0][0] as string
    expect(msg1).toContain('[buffered-channel] send')
    expect(msg1).toContain('sessionId=xyz')
    expect(msg1).toContain('depth=1')

    const msg2 = info.mock.calls[1][0] as string
    expect(msg2).toContain('depth=2')
  })

  it('non-verbose mode does not emit per-send logs', () => {
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn() }
    const ch = new BufferedChannel({ logger })

    ch.send({ seq: 1 })
    ch.send({ seq: 2 })

    expect(info).not.toHaveBeenCalled()
  })
})
