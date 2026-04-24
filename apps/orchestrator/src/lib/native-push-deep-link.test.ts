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

import {
  __resetForTests,
  consumePendingDeepLink,
  initNativePushDeepLink,
} from './native-push-deep-link'

function fireTap(data: Record<string, unknown>): void {
  const cb = listeners.get('pushNotificationActionPerformed')
  if (!cb) throw new Error('listener not registered')
  cb({ notification: { data } })
}

describe('native-push-deep-link', () => {
  beforeEach(() => {
    listeners.clear()
    mockAddListener.mockClear()
    isNativeMock.mockReturnValue(true)
    __resetForTests()
    // Default jsdom origin is http://localhost:3000.
    delete (globalThis as { __duraclaw_router__?: unknown }).__duraclaw_router__
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

  it('calls router.navigate when __duraclaw_router__ is set', async () => {
    const navigate = vi.fn()
    ;(globalThis as { __duraclaw_router__?: { navigate: typeof navigate } }).__duraclaw_router__ = {
      navigate,
    }

    await initNativePushDeepLink()
    fireTap({ url: '/?session=zzz', sessionId: 'zzz' })

    expect(navigate).toHaveBeenCalledWith({
      to: '/',
      search: { session: 'zzz' },
      replace: true,
    })
  })

  it('short-circuits on web (isNative() === false), no addListener call', async () => {
    isNativeMock.mockReturnValue(false)
    await initNativePushDeepLink()
    expect(mockAddListener).not.toHaveBeenCalled()
  })
})
