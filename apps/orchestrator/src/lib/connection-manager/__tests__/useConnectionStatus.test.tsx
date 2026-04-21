/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionRegistry } from '../registry'
import type { ConnectionEventListener, ManagedConnection } from '../types'
import { useConnectionStatus } from '../useConnectionStatus'

/**
 * Mock adapter whose `readyState` is externally mutable and whose
 * open/close listeners can be fired synchronously from the test.
 */
function makeAdapter(id: string, initial: number = WebSocket.OPEN) {
  const listeners = new Map<string, Set<ConnectionEventListener>>()
  let readyState = initial
  const conn: ManagedConnection = {
    id,
    kind: 'partysocket',
    get readyState() {
      return readyState
    },
    lastSeenTs: Date.now(),
    reconnect: vi.fn(),
    close: vi.fn(),
    addEventListener(event, fn) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(fn)
    },
    removeEventListener(event, fn) {
      listeners.get(event)?.delete(fn)
    },
  }
  const fire = (event: string) => {
    for (const fn of listeners.get(event) ?? []) fn(new Event(event))
  }
  const setReadyState = (v: number) => {
    readyState = v
  }
  return { conn, fire, setReadyState, listeners }
}

beforeEach(() => {
  connectionRegistry.__resetForTests()
})

afterEach(() => {
  cleanup()
  connectionRegistry.__resetForTests()
})

describe('useConnectionStatus', () => {
  it('isOnline is true when every registered conn is OPEN', () => {
    const { conn: a } = makeAdapter('a', WebSocket.OPEN)
    const { conn: b } = makeAdapter('b', WebSocket.OPEN)
    connectionRegistry.register(a)
    connectionRegistry.register(b)
    const { result } = renderHook(() => useConnectionStatus())
    expect(result.current.isOnline).toBe(true)
    expect(result.current.connections).toEqual([
      { id: 'a', readyState: WebSocket.OPEN },
      { id: 'b', readyState: WebSocket.OPEN },
    ])
  })

  it('isOnline flips to false when a conn closes', () => {
    const a = makeAdapter('a', WebSocket.OPEN)
    const b = makeAdapter('b', WebSocket.OPEN)
    connectionRegistry.register(a.conn)
    connectionRegistry.register(b.conn)
    const { result } = renderHook(() => useConnectionStatus())
    expect(result.current.isOnline).toBe(true)
    act(() => {
      b.setReadyState(WebSocket.CLOSED)
      b.fire('close')
    })
    expect(result.current.isOnline).toBe(false)
  })

  it('isOnline returns to true on open event after close', () => {
    const a = makeAdapter('a', WebSocket.CLOSED)
    connectionRegistry.register(a.conn)
    const { result } = renderHook(() => useConnectionStatus())
    expect(result.current.isOnline).toBe(false)
    act(() => {
      a.setReadyState(WebSocket.OPEN)
      a.fire('open')
    })
    expect(result.current.isOnline).toBe(true)
  })

  it('newly registered adapter participates in the derived signal', () => {
    const { result } = renderHook(() => useConnectionStatus())
    expect(result.current.isOnline).toBe(true) // empty → vacuous online
    const a = makeAdapter('a', WebSocket.CLOSED)
    act(() => {
      connectionRegistry.register(a.conn)
    })
    expect(result.current.isOnline).toBe(false)
  })

  it('unregistered adapter is dropped from `connections`', () => {
    const a = makeAdapter('a', WebSocket.OPEN)
    const b = makeAdapter('b', WebSocket.CLOSED)
    connectionRegistry.register(a.conn)
    const unreg = connectionRegistry.register(b.conn)
    const { result } = renderHook(() => useConnectionStatus())
    expect(result.current.connections).toHaveLength(2)
    act(() => {
      unreg()
    })
    expect(result.current.connections).toHaveLength(1)
    expect(result.current.connections[0].id).toBe('a')
    expect(result.current.isOnline).toBe(true)
  })

  it('listeners are cleaned up on unmount', () => {
    const a = makeAdapter('a', WebSocket.OPEN)
    connectionRegistry.register(a.conn)
    const { unmount } = renderHook(() => useConnectionStatus())
    expect(a.listeners.get('open')?.size).toBeGreaterThan(0)
    expect(a.listeners.get('close')?.size).toBeGreaterThan(0)
    unmount()
    expect(a.listeners.get('open')?.size ?? 0).toBe(0)
    expect(a.listeners.get('close')?.size ?? 0).toBe(0)
  })
})
