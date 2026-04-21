/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Lifecycle source is mocked so we can fire events synchronously from
// tests. The production lifecycle.ts is exercised separately.
const lifecycleMock = vi.hoisted(() => {
  let currentListener: ((event: string) => void) | null = null
  return {
    fire(event: string) {
      currentListener?.(event)
    },
    set(fn: ((event: string) => void) | null) {
      currentListener = fn
    },
    get() {
      return currentListener
    },
  }
})

vi.mock('../lifecycle', () => ({
  lifecycleEventSource: {
    subscribe(fn: (event: string) => void) {
      lifecycleMock.set(fn)
      return () => {
        if (lifecycleMock.get() === fn) lifecycleMock.set(null)
      }
    },
    __resetForTests() {
      lifecycleMock.set(null)
    },
  },
}))

import { connectionManager } from '../manager'
import { connectionRegistry } from '../registry'
import type { ManagedConnection } from '../types'

function makeConn(id: string, lastSeenOffset = -6000): ManagedConnection {
  return {
    id,
    kind: 'partysocket',
    readyState: 1,
    lastSeenTs: Date.now() + lastSeenOffset,
    reconnect: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-21T12:00:00Z'))
  connectionRegistry.__resetForTests()
  connectionManager.__resetForTests()
})

afterEach(() => {
  vi.useRealTimers()
  connectionRegistry.__resetForTests()
  connectionManager.__resetForTests()
})

describe('connectionManager', () => {
  it('schedules reconnect on foreground when conn is stale (>5s)', () => {
    connectionManager.start({ random: () => 0 })
    const conn = makeConn('a', -6000) // stale
    connectionRegistry.register(conn)
    lifecycleMock.fire('foreground')
    vi.advanceTimersByTime(500)
    expect(conn.reconnect).toHaveBeenCalledTimes(1)
    expect(conn.reconnect).toHaveBeenCalledWith(undefined, 'cm-foreground')
  })

  it('does NOT schedule reconnect when conn is fresh (<5s)', () => {
    connectionManager.start({ random: () => 0 })
    const conn = makeConn('a', -2000) // fresh
    connectionRegistry.register(conn)
    lifecycleMock.fire('foreground')
    vi.advanceTimersByTime(600)
    expect(conn.reconnect).not.toHaveBeenCalled()
  })

  it('ignores background / offline / hidden / visible', () => {
    connectionManager.start({ random: () => 0 })
    const conn = makeConn('a', -60_000)
    connectionRegistry.register(conn)
    for (const ev of ['background', 'offline', 'hidden', 'visible']) {
      lifecycleMock.fire(ev)
    }
    vi.advanceTimersByTime(600)
    expect(conn.reconnect).not.toHaveBeenCalled()
  })

  it('staggers per-conn reconnects using the injected random source', () => {
    // Deterministic random sequence produces delays [0, 100, 200, 300, 400]
    const seq = [0, 0.2, 0.4, 0.6, 0.8]
    let i = 0
    connectionManager.start({ random: () => seq[i++] })
    const conns = [0, 1, 2, 3, 4].map((n) => makeConn(`c${n}`, -10_000))
    for (const c of conns) connectionRegistry.register(c)
    lifecycleMock.fire('foreground')
    vi.advanceTimersByTime(99)
    expect(conns[0].reconnect).toHaveBeenCalledTimes(1)
    expect(conns[1].reconnect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(conns[1].reconnect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(conns[2].reconnect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(conns[3].reconnect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(conns[4].reconnect).toHaveBeenCalledTimes(1)
  })

  it('default random source (Math.random) produces at least one distinct delay pair across 5 conns', () => {
    connectionManager.start() // default Math.random
    const conns = [0, 1, 2, 3, 4].map((n) => makeConn(`c${n}`, -10_000))
    for (const c of conns) connectionRegistry.register(c)
    const log = connectionManager.lastReconnectLog
    const before = log.length
    lifecycleMock.fire('online')
    const after = connectionManager.lastReconnectLog.slice(before)
    const delays = new Set(after.map((e) => e.delay))
    expect(delays.size).toBeGreaterThanOrEqual(2)
  })

  it('rapid foreground/background flip does not duplicate reconnect for same conn', () => {
    connectionManager.start({ random: () => 0.5 })
    const conn = makeConn('a', -10_000)
    connectionRegistry.register(conn)
    lifecycleMock.fire('foreground')
    vi.advanceTimersByTime(50)
    lifecycleMock.fire('background')
    // Re-fire foreground before first timer elapses — the first timer
    // should be cancelled and rescheduled, not both fire.
    lifecycleMock.fire('foreground')
    vi.advanceTimersByTime(500)
    expect(conn.reconnect).toHaveBeenCalledTimes(1)
  })

  it('stop() clears pending timers — scheduled reconnect never fires', () => {
    connectionManager.start({ random: () => 0.5 })
    const conn = makeConn('a', -10_000)
    connectionRegistry.register(conn)
    lifecycleMock.fire('foreground')
    connectionManager.stop()
    vi.advanceTimersByTime(1000)
    expect(conn.reconnect).not.toHaveBeenCalled()
  })

  it('reconnectAll fires reconnect on every conn regardless of lastSeenTs or stagger', () => {
    connectionManager.start({ random: () => 0 })
    const fresh = makeConn('fresh', -500) // fresh
    const stale = makeConn('stale', -60_000) // stale
    connectionRegistry.register(fresh)
    connectionRegistry.register(stale)
    connectionManager.reconnectAll()
    expect(fresh.reconnect).toHaveBeenCalledTimes(1)
    expect(stale.reconnect).toHaveBeenCalledTimes(1)
  })

  it('double start is a no-op (does not re-subscribe)', () => {
    connectionManager.start({ random: () => 0 })
    const first = lifecycleMock.get()
    connectionManager.start() // no-op
    expect(lifecycleMock.get()).toBe(first)
  })

  it('throw from one conn reconnect does not starve the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      connectionManager.start({ random: () => 0 })
      const bad = makeConn('bad', -10_000)
      ;(
        bad.reconnect as unknown as { mockImplementation(fn: () => void): void }
      ).mockImplementation(() => {
        throw new Error('boom')
      })
      const good = makeConn('good', -10_000)
      connectionRegistry.register(bad)
      connectionRegistry.register(good)
      lifecycleMock.fire('foreground')
      vi.advanceTimersByTime(500)
      expect(bad.reconnect).toHaveBeenCalledTimes(1)
      expect(good.reconnect).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
