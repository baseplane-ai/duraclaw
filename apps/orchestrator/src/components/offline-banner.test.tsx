/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionRegistry } from '~/lib/connection-manager/registry'
import type { ConnectionEventListener, ManagedConnection } from '~/lib/connection-manager/types'
import { OfflineBanner } from './offline-banner'

function makeAdapter(id: string, initial: number) {
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
  return { conn, fire, setReadyState }
}

beforeEach(() => {
  vi.useFakeTimers()
  connectionRegistry.__resetForTests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  connectionRegistry.__resetForTests()
})

describe('OfflineBanner (unified connection-manager signal)', () => {
  it('is hidden while all conns are OPEN', () => {
    const a = makeAdapter('a', WebSocket.OPEN)
    connectionRegistry.register(a.conn)
    render(<OfflineBanner />)
    expect(screen.queryByText('Reconnecting…')).toBeNull()
  })

  it('sub-1s disconnect is absorbed by debounce (banner never renders)', () => {
    const a = makeAdapter('a', WebSocket.OPEN)
    const b = makeAdapter('b', WebSocket.OPEN)
    const c = makeAdapter('c', WebSocket.OPEN)
    connectionRegistry.register(a.conn)
    connectionRegistry.register(b.conn)
    connectionRegistry.register(c.conn)
    render(<OfflineBanner />)
    act(() => {
      b.setReadyState(WebSocket.CLOSED)
      b.fire('close')
      vi.advanceTimersByTime(400)
    })
    expect(screen.queryByText('Reconnecting…')).toBeNull()
    act(() => {
      b.setReadyState(WebSocket.OPEN)
      b.fire('open')
      vi.advanceTimersByTime(1500)
    })
    expect(screen.queryByText('Reconnecting…')).toBeNull()
  })

  it('sustained disconnect >1s shows the banner', () => {
    const a = makeAdapter('a', WebSocket.OPEN)
    connectionRegistry.register(a.conn)
    render(<OfflineBanner />)
    act(() => {
      a.setReadyState(WebSocket.CLOSED)
      a.fire('close')
    })
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
  })

  it('recovery hides the banner immediately (no hide-debounce)', () => {
    const a = makeAdapter('a', WebSocket.OPEN)
    connectionRegistry.register(a.conn)
    render(<OfflineBanner />)
    act(() => {
      a.setReadyState(WebSocket.CLOSED)
      a.fire('close')
    })
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
    act(() => {
      a.setReadyState(WebSocket.OPEN)
      a.fire('open')
    })
    expect(screen.queryByText('Reconnecting…')).toBeNull()
  })
})
