/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted Capacitor mocks ──────────────────────────────────────────
const mocks = vi.hoisted(() => {
  let isNativeValue = false
  let appCb: ((s: { isActive: boolean }) => void) | null = null
  let netCb: ((s: { connected: boolean }) => void) | null = null
  const appRemove = vi.fn()
  const netRemove = vi.fn()
  const appAddListener = vi.fn(async (_ev: string, cb: (s: { isActive: boolean }) => void) => {
    appCb = cb
    return { remove: appRemove }
  })
  const netAddListener = vi.fn(async (_ev: string, cb: (s: { connected: boolean }) => void) => {
    netCb = cb
    return { remove: netRemove }
  })
  const getStatus = vi.fn(async () => ({ connected: true }))
  return {
    setIsNative(v: boolean) {
      isNativeValue = v
    },
    getIsNative() {
      return isNativeValue
    },
    fireAppState(s: { isActive: boolean }) {
      appCb?.(s)
    },
    fireNetworkStatus(s: { connected: boolean }) {
      netCb?.(s)
    },
    appCb: () => appCb,
    netCb: () => netCb,
    appAddListener,
    netAddListener,
    getStatus,
    appRemove,
    netRemove,
    reset() {
      isNativeValue = false
      appCb = null
      netCb = null
      appAddListener.mockClear()
      netAddListener.mockClear()
      getStatus.mockReset()
      getStatus.mockImplementation(async () => ({ connected: true }))
      appRemove.mockReset()
      netRemove.mockReset()
    },
  }
})

vi.mock('~/lib/platform', () => ({
  isNative: () => mocks.getIsNative(),
  // GH#132 P3: Expo native branch is gated separately. Tests against
  // the Capacitor lifecycle path keep this false; Expo lifecycle has
  // its own coverage in tests covering installExpoNative.
  isExpoNative: () => false,
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (ev: string, cb: (s: { isActive: boolean }) => void) =>
      mocks.appAddListener(ev, cb),
  },
}))

vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: (ev: string, cb: (s: { connected: boolean }) => void) =>
      mocks.netAddListener(ev, cb),
    getStatus: () => mocks.getStatus(),
  },
}))

import { lifecycleEventSource } from '../lifecycle'

async function flushUntil(cond: () => boolean, maxIters = 100): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return
    await Promise.resolve()
  }
}

beforeEach(() => {
  mocks.reset()
  lifecycleEventSource.__resetForTests()
})

afterEach(() => {
  lifecycleEventSource.__resetForTests()
})

describe('lifecycleEventSource (web)', () => {
  it('emits "online" on window.online event', () => {
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    window.dispatchEvent(new Event('online'))
    expect(fn).toHaveBeenCalledWith('online')
  })

  it('emits "offline" on window.offline event', () => {
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    window.dispatchEvent(new Event('offline'))
    expect(fn).toHaveBeenCalledWith('offline')
  })

  it('emits "hidden"/"visible" on visibilitychange', () => {
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fn).toHaveBeenLastCalledWith('hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fn).toHaveBeenLastCalledWith('visible')
  })

  it('unsubscribe removes DOM listeners', () => {
    const fn = vi.fn()
    const unsub = lifecycleEventSource.subscribe(fn)
    unsub()
    window.dispatchEvent(new Event('online'))
    expect(fn).not.toHaveBeenCalled()
  })

  it('multiple subscribers each receive each event', () => {
    const a = vi.fn()
    const b = vi.fn()
    lifecycleEventSource.subscribe(a)
    lifecycleEventSource.subscribe(b)
    window.dispatchEvent(new Event('online'))
    expect(a).toHaveBeenCalledWith('online')
    expect(b).toHaveBeenCalledWith('online')
  })
})

describe('lifecycleEventSource (native mock)', () => {
  beforeEach(() => {
    mocks.setIsNative(true)
  })

  it('simulated appStateChange { isActive: true } invokes fn with "foreground"', async () => {
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    await flushUntil(() => mocks.appCb() != null)
    mocks.fireAppState({ isActive: true })
    expect(fn).toHaveBeenCalledWith('foreground')
  })

  it('simulated appStateChange { isActive: false } invokes fn with "background"', async () => {
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    await flushUntil(() => mocks.appCb() != null)
    mocks.fireAppState({ isActive: false })
    expect(fn).toHaveBeenCalledWith('background')
  })

  it('simulated networkStatusChange { connected: false } invokes fn with "offline"', async () => {
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    await flushUntil(() => mocks.netCb() != null)
    mocks.fireNetworkStatus({ connected: false })
    expect(fn).toHaveBeenCalledWith('offline')
  })

  it('Network.getStatus returning { connected: false } on subscribe fires "offline"', async () => {
    mocks.getStatus.mockImplementation(async () => ({ connected: false }))
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    await flushUntil(() => fn.mock.calls.some((c) => c[0] === 'offline'))
    expect(fn).toHaveBeenCalledWith('offline')
  })

  it('Network.getStatus returning { connected: true } on subscribe fires "online"', async () => {
    mocks.getStatus.mockImplementation(async () => ({ connected: true }))
    const fn = vi.fn()
    lifecycleEventSource.subscribe(fn)
    await flushUntil(() => fn.mock.calls.some((c) => c[0] === 'online'))
    expect(fn).toHaveBeenCalledWith('online')
  })

  it('unsubscribe removes Capacitor + DOM listeners', async () => {
    const fn = vi.fn()
    const unsub = lifecycleEventSource.subscribe(fn)
    await flushUntil(() => mocks.appCb() != null && mocks.netCb() != null)
    unsub()
    expect(mocks.appRemove).toHaveBeenCalledTimes(1)
    expect(mocks.netRemove).toHaveBeenCalledTimes(1)
    fn.mockReset()
    window.dispatchEvent(new Event('online'))
    expect(fn).not.toHaveBeenCalled()
  })
})
