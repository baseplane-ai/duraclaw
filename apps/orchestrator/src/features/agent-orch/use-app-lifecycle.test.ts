/**
 * Tests for useAppLifecycle (app-lifecycle hook).
 *
 * @vitest-environment jsdom
 */
import { cleanup, renderHook } from '@testing-library/react'
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

/** Wait until both async Capacitor listener IIFEs have installed their callbacks. */
async function flushAsync() {
  for (let i = 0; i < 100; i++) {
    if (mocks.appListenerCb() != null && mocks.netListenerCb() != null) return
    await Promise.resolve()
  }
}

/** Simulate visibilitychange → 'visible' fired on document. */
function fireVisible() {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Simulate visibilitychange → 'hidden' fired on document. */
function fireHidden() {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'hidden',
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.reset()
  vi.useFakeTimers()
  // Pin an initial time so Date.now() advances deterministically via
  // vi.advanceTimersByTime / vi.setSystemTime.
  vi.setSystemTime(new Date('2026-04-21T00:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useAppLifecycle', () => {
  describe('native (isNative() === true)', () => {
    it('installs Capacitor + DOM listeners', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))
      await flushAsync()
      expect(mocks.appAddListenerMock).toHaveBeenCalledTimes(1)
      expect(mocks.netAddListenerMock).toHaveBeenCalledTimes(1)
    })

    it('foreground (appStateChange isActive=true) kicks reconnect + user-stream + hydrate', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))
      await flushAsync()

      mocks.fireAppState({ isActive: true })
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledTimes(1)
    })

    it('background (isActive=false) does not kick', async () => {
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

    it('network reconnect (connected=true) kicks', async () => {
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

    it('dedupes a visibilitychange + appStateChange burst into one kick (500ms debounce)', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))
      await flushAsync()

      // Real-world resume on Android: WebView thaws → visibilitychange
      // fires synchronously → native bridge delivers appStateChange a
      // few ms later. Expect a single kick.
      fireVisible()
      mocks.fireAppState({ isActive: true })
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledTimes(1)
    })
  })

  describe('web (isNative() === false)', () => {
    beforeEach(() => {
      mocks.setIsNative(false)
    })

    it('does not install Capacitor listeners', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))
      await flushAsync()
      expect(mocks.appAddListenerMock).not.toHaveBeenCalled()
      expect(mocks.netAddListenerMock).not.toHaveBeenCalled()
    })

    it('visibilitychange → visible kicks reconnect + user-stream + hydrate', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))

      fireVisible()
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledTimes(1)
    })

    it('visibilitychange → hidden does not kick', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))

      fireHidden()
      expect(reconnect).not.toHaveBeenCalled()
      expect(mocks.reconnectUserStreamNowMock).not.toHaveBeenCalled()
      expect(hydrate).not.toHaveBeenCalled()
    })

    it('window focus kicks (covers laptop unlock / alt-tab back to browser)', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))

      window.dispatchEvent(new Event('focus'))
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledTimes(1)
    })

    it('pageshow kicks (covers bfcache restore)', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))

      window.dispatchEvent(new Event('pageshow'))
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledTimes(1)
    })

    it('visibilitychange + focus + pageshow burst dedupes to one kick', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))

      fireVisible()
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('pageshow'))
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(mocks.reconnectUserStreamNowMock).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledTimes(1)
    })

    it('a second kick after the debounce window (>500ms) fires again', async () => {
      const hydrate = vi.fn()
      const reconnect = vi.fn()
      renderHook(() => useAppLifecycle({ hydrate, reconnect }))

      fireVisible()
      expect(reconnect).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(600)
      fireVisible()
      expect(reconnect).toHaveBeenCalledTimes(2)
    })
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

  it('cleanup removes all listeners (native path)', async () => {
    const hydrate = vi.fn()
    const reconnect = vi.fn()
    const { unmount } = renderHook(() => useAppLifecycle({ hydrate, reconnect }))
    await flushAsync()

    unmount()
    expect(mocks.appRemoveMock).toHaveBeenCalledTimes(1)
    expect(mocks.netRemoveMock).toHaveBeenCalledTimes(1)

    // After cleanup DOM listeners are detached too — a visibility event
    // must not trigger another kick.
    reconnect.mockReset()
    hydrate.mockReset()
    mocks.reconnectUserStreamNowMock.mockReset()
    vi.advanceTimersByTime(600)
    fireVisible()
    expect(reconnect).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
    expect(mocks.reconnectUserStreamNowMock).not.toHaveBeenCalled()
  })
})
