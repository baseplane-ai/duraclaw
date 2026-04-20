/**
 * Tests for useAppLifecycle (Capacitor app-lifecycle hook).
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

/** Wait until the async IIFE inside useEffect has installed its listener. */
async function flushAsync() {
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
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate }))
    await flushAsync()
    expect(mocks.addListenerMock).not.toHaveBeenCalled()
  })

  it('foreground calls hydrate()', async () => {
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate }))
    await flushAsync()
    expect(mocks.addListenerMock).toHaveBeenCalledTimes(1)

    mocks.fire({ isActive: true })
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('background does not call hydrate()', async () => {
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate }))
    await flushAsync()

    mocks.fire({ isActive: false })
    vi.advanceTimersByTime(60_000)
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('background → foreground cycle calls hydrate() on foreground only', async () => {
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate }))
    await flushAsync()

    mocks.fire({ isActive: false })
    expect(hydrate).not.toHaveBeenCalled()
    mocks.fire({ isActive: true })
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('cleanup removes listener', async () => {
    const hydrate = vi.fn()
    const { unmount } = renderHook(() => useAppLifecycle({ hydrate }))
    await flushAsync()

    unmount()
    expect(mocks.removeMock).toHaveBeenCalledTimes(1)
  })
})
