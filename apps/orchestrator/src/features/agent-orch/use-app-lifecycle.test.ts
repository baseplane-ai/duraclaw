/**
 * Tests for useAppLifecycle (B6 — Capacitor app-lifecycle hook).
 *
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  let isNativeValue = true
  let listenerCb: ((s: { isActive: boolean }) => void) | null = null
  const removeMock = vi.fn()
  const addListenerMock = vi.fn(async (_event: string, cb: (s: { isActive: boolean }) => void) => {
    listenerCb = cb
    return { remove: removeMock }
  })
  return {
    setIsNative(v: boolean) {
      isNativeValue = v
    },
    getIsNative() {
      return isNativeValue
    },
    fire(state: { isActive: boolean }) {
      listenerCb?.(state)
    },
    listenerCb: () => listenerCb,
    removeMock,
    addListenerMock,
    reset() {
      isNativeValue = true
      listenerCb = null
      removeMock.mockReset()
      addListenerMock.mockClear()
    },
  }
})

vi.mock('~/lib/platform', () => ({
  isNative: () => mocks.getIsNative(),
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (event: string, cb: (s: { isActive: boolean }) => void) =>
      mocks.addListenerMock(event, cb),
  },
}))

import { useAppLifecycle } from './use-app-lifecycle'

// ── Helpers ──────────────────────────────────────────────────────────

function makeConnection() {
  return {
    readyState: 1,
    close: vi.fn(),
    reconnect: vi.fn(),
  }
}

/** Wait until the async IIFE inside useEffect has installed its listener. */
async function flushAsync() {
  // Loop until addListener has run (dynamic import + await chain). Cap
  // attempts so a real failure shows up as a stuck listener instead of
  // an infinite hang.
  for (let i = 0; i < 50; i++) {
    if (mocks.addListenerMock.mock.calls.length > 0 && mocks.listenerCb() != null) return
    await Promise.resolve()
  }
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.reset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAppLifecycle', () => {
  it('is a no-op when isNative() is false (no listener added)', async () => {
    mocks.setIsNative(false)
    const connection = makeConnection()
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ connection, hydrate }))
    await flushAsync()
    expect(mocks.addListenerMock).not.toHaveBeenCalled()
  })

  it('background → 5s timer triggers connection.close()', async () => {
    const connection = makeConnection()
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ connection, hydrate }))
    await flushAsync()
    expect(mocks.addListenerMock).toHaveBeenCalledTimes(1)

    mocks.fire({ isActive: false })
    expect(connection.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4999)
    expect(connection.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(connection.close).toHaveBeenCalledTimes(1)
  })

  it('foreground within 5s cancels timer, calls hydrate()', async () => {
    const connection = makeConnection()
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ connection, hydrate }))
    await flushAsync()

    mocks.fire({ isActive: false })
    vi.advanceTimersByTime(2000)
    mocks.fire({ isActive: true })
    expect(hydrate).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(connection.close).not.toHaveBeenCalled()
  })

  it('foreground after 5s still calls hydrate()', async () => {
    const connection = makeConnection()
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ connection, hydrate }))
    await flushAsync()

    mocks.fire({ isActive: false })
    vi.advanceTimersByTime(5000)
    expect(connection.close).toHaveBeenCalledTimes(1)
    mocks.fire({ isActive: true })
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('cleanup removes listener and clears pending timer', async () => {
    const connection = makeConnection()
    const hydrate = vi.fn()
    const { unmount } = renderHook(() => useAppLifecycle({ connection, hydrate }))
    await flushAsync()

    mocks.fire({ isActive: false })
    unmount()
    expect(mocks.removeMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    // Timer should have been cleared on unmount.
    expect(connection.close).not.toHaveBeenCalled()
  })
})
