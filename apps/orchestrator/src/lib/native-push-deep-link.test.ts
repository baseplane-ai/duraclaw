/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the registered listeners so tests can fire them.
const listeners = new Map<string, (arg: unknown) => unknown>()

const mockAddListener = vi.fn(async (event: string, cb: (arg: unknown) => unknown) => {
  listeners.set(event, cb)
  return { remove: vi.fn() }
})

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    addListener: (event: string, cb: (arg: unknown) => unknown) => mockAddListener(event, cb),
  },
}))

const isNativeMock = vi.fn(() => true)
vi.mock('~/lib/platform', () => ({
  isNative: () => isNativeMock(),
}))

// Capture lifecycle subscribers so tests can fire foreground/visible events.
type LifecycleEvent = 'foreground' | 'background' | 'online' | 'offline' | 'visible' | 'hidden'
const lifecycleListeners = new Set<(event: LifecycleEvent) => void>()
vi.mock('~/lib/connection-manager/lifecycle', () => ({
  lifecycleEventSource: {
    subscribe: (fn: (event: LifecycleEvent) => void) => {
      lifecycleListeners.add(fn)
      return () => {
        lifecycleListeners.delete(fn)
      }
    },
  },
}))

function fireLifecycle(event: LifecycleEvent): void {
  for (const fn of lifecycleListeners) fn(event)
}

import {
  __resetForTests,
  __setPendingDeepLinkForTests,
  consumePendingDeepLink,
  initNativePushDeepLink,
  subscribeDeepLink,
} from './native-push-deep-link'

function fireTap(data: Record<string, unknown>): void {
  const cb = listeners.get('pushNotificationActionPerformed')
  if (!cb) throw new Error('listener not registered')
  cb({ notification: { data } })
}

describe('native-push-deep-link', () => {
  beforeEach(() => {
    listeners.clear()
    lifecycleListeners.clear()
    mockAddListener.mockClear()
    isNativeMock.mockReturnValue(true)
    __resetForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers a pushNotificationActionPerformed listener on init', async () => {
    await initNativePushDeepLink()
    expect(mockAddListener).toHaveBeenCalledWith(
      'pushNotificationActionPerformed',
      expect.any(Function),
    )
  })

  it('stashes session id from data.url and consumePendingDeepLink returns it once', async () => {
    await initNativePushDeepLink()
    fireTap({ url: '/?session=abc', sessionId: 'abc' })

    expect(consumePendingDeepLink()).toBe('abc')
    // Subsequent call returns null — the slot was cleared.
    expect(consumePendingDeepLink()).toBeNull()
  })

  it('rejects cross-origin URLs (pending stays null)', async () => {
    await initNativePushDeepLink()
    fireTap({ url: 'https://evil.example.com/?session=abc' })

    expect(consumePendingDeepLink()).toBeNull()
  })

  it('notifies subscribers with the session id on tap', async () => {
    const fn = vi.fn()
    subscribeDeepLink(fn)

    await initNativePushDeepLink()
    fireTap({ url: '/?session=zzz', sessionId: 'zzz' })

    expect(fn).toHaveBeenCalledWith('zzz')
  })

  it('subscribeDeepLink unsubscribe stops further notifications', async () => {
    const fn = vi.fn()
    const unsub = subscribeDeepLink(fn)

    await initNativePushDeepLink()
    fireTap({ url: '/?session=first' })
    expect(fn).toHaveBeenCalledTimes(1)

    unsub()
    fireTap({ url: '/?session=second' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not notify subscribers for cross-origin URLs', async () => {
    const fn = vi.fn()
    subscribeDeepLink(fn)

    await initNativePushDeepLink()
    fireTap({ url: 'https://evil.example.com/?session=abc' })

    expect(fn).not.toHaveBeenCalled()
  })

  it('subscriber throw is isolated and does not break other subscribers', async () => {
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    subscribeDeepLink(bad)
    subscribeDeepLink(good)

    await initNativePushDeepLink()
    fireTap({ url: '/?session=ok' })

    expect(bad).toHaveBeenCalledWith('ok')
    expect(good).toHaveBeenCalledWith('ok')
  })

  it('__setPendingDeepLinkForTests + consumePendingDeepLink round-trip', () => {
    __setPendingDeepLinkForTests('/?session=fromtest')
    expect(consumePendingDeepLink()).toBe('fromtest')
    expect(consumePendingDeepLink()).toBeNull()
  })

  it('short-circuits on web (isNative() === false), no addListener call', async () => {
    isNativeMock.mockReturnValue(false)
    await initNativePushDeepLink()
    expect(mockAddListener).not.toHaveBeenCalled()
  })

  it('lifecycle foreground drains pending into a late subscriber (warm-start race)', async () => {
    // Tap arrives BEFORE any subscriber has registered (the warm-start
    // race that the bug exhibits in the wild).
    await initNativePushDeepLink()
    fireTap({ url: '/?session=warm' })

    // Now React mounts and registers its subscriber.
    const fn = vi.fn()
    subscribeDeepLink(fn)
    expect(fn).not.toHaveBeenCalled()

    // Capacitor's `App.appStateChange` fires `foreground` ~30ms later.
    fireLifecycle('foreground')
    expect(fn).toHaveBeenCalledWith('warm')
  })

  it('lifecycle visible also drains pending', async () => {
    await initNativePushDeepLink()
    fireTap({ url: '/?session=vis' })

    const fn = vi.fn()
    subscribeDeepLink(fn)

    fireLifecycle('visible')
    expect(fn).toHaveBeenCalledWith('vis')
  })

  it('lifecycle drain skipped (slot retained) when no subscribers', async () => {
    await initNativePushDeepLink()
    fireTap({ url: '/?session=retained' })

    // Lifecycle fires before any subscriber registers — slot must be
    // retained so the cold-start `consumePendingDeepLink()` path can
    // still pick it up.
    fireLifecycle('foreground')

    expect(consumePendingDeepLink()).toBe('retained')
  })

  it('lifecycle background / online / offline / hidden do NOT drain', async () => {
    await initNativePushDeepLink()
    fireTap({ url: '/?session=stay' })

    const fn = vi.fn()
    subscribeDeepLink(fn)

    fireLifecycle('background')
    fireLifecycle('online')
    fireLifecycle('offline')
    fireLifecycle('hidden')
    expect(fn).not.toHaveBeenCalled()

    // Slot still retained for a real foreground.
    fireLifecycle('foreground')
    expect(fn).toHaveBeenCalledWith('stay')
  })

  it('__resetForTests detaches the lifecycle subscription', async () => {
    await initNativePushDeepLink()
    expect(lifecycleListeners.size).toBe(1)
    __resetForTests()
    expect(lifecycleListeners.size).toBe(0)
  })
})
