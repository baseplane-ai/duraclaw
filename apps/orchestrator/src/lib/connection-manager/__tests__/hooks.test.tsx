/**
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useManagedConnection } from '../hooks'
import { connectionRegistry } from '../registry'
import type { ManagedConnection } from '../types'

function makeConn(id: string): ManagedConnection {
  return {
    id,
    kind: 'partysocket',
    readyState: 1,
    lastSeenTs: Date.now(),
    reconnect: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

beforeEach(() => {
  connectionRegistry.__resetForTests()
})

afterEach(() => {
  cleanup()
  connectionRegistry.__resetForTests()
})

describe('useManagedConnection', () => {
  it('registers on mount, unregisters on unmount', () => {
    const conn = makeConn('a')
    const { unmount } = renderHook(() => useManagedConnection(conn, 'a'))
    expect(connectionRegistry.snapshot()).toEqual([conn])
    unmount()
    expect(connectionRegistry.snapshot()).toHaveLength(0)
  })

  it('null conn is a no-op', () => {
    const { unmount } = renderHook(() => useManagedConnection(null, 'a'))
    expect(connectionRegistry.snapshot()).toHaveLength(0)
    unmount()
  })

  it('re-registers when conn reference changes', () => {
    const conn1 = makeConn('a')
    const conn2 = makeConn('a')
    const { rerender, unmount } = renderHook(
      ({ c }: { c: ManagedConnection }) => useManagedConnection(c, 'a'),
      { initialProps: { c: conn1 } },
    )
    expect(connectionRegistry.snapshot()).toEqual([conn1])
    rerender({ c: conn2 })
    expect(connectionRegistry.snapshot()).toEqual([conn2])
    unmount()
    expect(connectionRegistry.snapshot()).toHaveLength(0)
  })
})
