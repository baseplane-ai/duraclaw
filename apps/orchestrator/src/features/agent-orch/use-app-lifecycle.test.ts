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
  let appListenerCb: ((s: { isActive: boolean }) => void) | null = null
  let netListenerCb: ((s: { connected: boolean }) => void) | null = null
  const appRemoveMock = vi.fn()
  const netRemoveMock = vi.fn()
  const appAddListenerMock = vi.fn(
    async (_event: string, cb: (s: { isActive: boolean }) => void) => {
      appListenerCb = cb
      return { remove: appRemoveMock }
    },
  )
  const netAddListenerMock = vi.fn(
    async (_event: string, cb: (s: { connected: boolean }) => void) => {
      netListenerCb = cb
      return { remove: netRemoveMock }
    },
  )
  const reconnectUserStreamNowMock = vi.fn()
  return {
    setIsNative(v: boolean) {
      isNativeValue = v
    },
    getIsNative() {
      return isNativeValue
    },
    fireAppState(state: { isActive: boolean }) {
      appListenerCb?.(state)
    },
    fireNetworkStatus(state: { connected: boolean }) {
      netListenerCb?.(state)
    },
    appListenerCb: () => appListenerCb,
    netListenerCb: () => netListenerCb,
    appRemoveMock,
    netRemoveMock,
    appAddListenerMock,
    netAddListenerMock,
    reconnectUserStreamNowMock,
    reset() {
      isNativeValue = true
      appListenerCb = null
      netListenerCb = null
      appRemoveMock.mockReset()
      netRemoveMock.mockReset()
      appAddListenerMock.mockClear()
      netAddListenerMock.mockClear()
      reconnectUserStreamNowMock.mockReset()
    },
  }
})

vi.mock('~/lib/platform', () => ({
  isNative: () => mocks.getIsNative(),
}))

vi.mock('~/hooks/use-user-stream', () => ({
  reconnectUserStreamNow: () => mocks.reconnectUserStreamNowMock(),
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (event: string, cb: (s: { isActive: boolean }) => void) =>
      mocks.appAddListenerMock(event, cb),
  },
}))

vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: (event: string, cb: (s: { connected: boolean }) => void) =>
      mocks.netAddListenerMock(event, cb),
  },
}))

import { useAppLifecycle } from './use-app-lifecycle'

/** Wait until both async listener IIFEs have installed their callbacks. */
async function flushAsync() {
  for (let i = 0; i < 100; i++) {
    if (mocks.appListenerCb() != null && mocks.netListenerCb() != null) return
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
  it('is a no-op when isNative() is false (no listeners added)', async () => {
    mocks.setIsNative(false)
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()
    expect(mocks.appAddListenerMock).not.toHaveBeenCalled()
    expect(mocks.netAddListenerMock).not.toHaveBeenCalled()
    expect(mocks.reconnectUserStreamNowMock).not.toHaveBeenCalled()
  })

  it('foreground kicks per-session reconnect + user-stream reconnect + hydrate', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()
    expect(mocks.appAddListenerMock).toHaveBeenCalledTimes(1)
    expect(mocks.netAddListenerMock).toHaveBeenCalledTimes(1)

    mocks.fireAppState({ isActive: true })
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('background does not kick reconnect or hydrate', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()

    mocks.fireAppState({ isActive: false })
    vi.advanceTimersByTime(60_000)
    expect(hydrate).not.toHaveBeenCalled()
    expect(reconnect).not.toHaveBeenCalled()
    expect(mocks.reconnectUserStreamNowMock).not.toHaveBeenCalled()
  })

  it('background → foreground cycle kicks only on foreground', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()

    mocks.fireAppState({ isActive: false })
    expect(hydrate).not.toHaveBeenCalled()
    mocks.fireAppState({ isActive: true })
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('network reconnect (connected=true) kicks reconnect + hydrate', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()

    mocks.fireNetworkStatus({ connected: true })
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('network disconnect (connected=false) does not kick', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()

    mocks.fireNetworkStatus({ connected: false })
    expect(reconnect).not.toHaveBeenCalled()
    expect(mocks.reconnectUserStreamNowMock).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('reconnect is optional — hydrate + user-stream reconnect still fire without it', async () => {
    const hydrate = vi.fn()
    renderHook(() => useAppLifecycle({ hydrate }))
    await flushAsync()

    mocks.fireAppState({ isActive: true })
    expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledTimes(1)
  })

  it('a throw from one callback does not starve the others', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn(() => {
      throw new Error('boom')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))
      await flushAsync()

      mocks.fireAppState({ isActive: true })
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('cleanup removes both listeners', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    const { unmount } = renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()

    unmount()
    expect(mocks.appRemoveMock).toHaveBeenCalledTimes(1)
    expect(mocks.netRemoveMock).toHaveBeenCalledTimes(1)
  })
})
