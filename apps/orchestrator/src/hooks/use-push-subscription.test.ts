/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePushSubscription } from './use-push-subscription'

// Helpers to build mock subscription and registration
function makeMockSubscription(endpoint = 'https://push.example.com/sub1') {
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  }
}

function makeMockPushManager(existingSub: ReturnType<typeof makeMockSubscription> | null = null) {
  return {
    getSubscription: vi.fn().mockResolvedValue(existingSub),
    subscribe: vi.fn().mockResolvedValue(existingSub ?? makeMockSubscription()),
  }
}

function makeMockRegistration(pushManager = makeMockPushManager()) {
  return { pushManager } as unknown as ServiceWorkerRegistration
}

describe('usePushSubscription', () => {
  let mockRegistration: ServiceWorkerRegistration
  let mockPushManager: ReturnType<typeof makeMockPushManager>

  beforeEach(() => {
    mockPushManager = makeMockPushManager()
    mockRegistration = makeMockRegistration(mockPushManager)

    // Mock serviceWorker.ready
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: Promise.resolve(mockRegistration) },
      configurable: true,
    })

    // Mock Notification
    Object.defineProperty(window, 'Notification', {
      value: { permission: 'default', requestPermission: vi.fn() },
      configurable: true,
    })

    // Mock fetch
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LNi' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns unsupported when Notification API is missing', () => {
    // Delete Notification from window so 'Notification' in window is false
    const orig = window.Notification
    // biome-ignore lint/performance/noDelete: test needs real property removal
    delete (window as any).Notification

    const { result } = renderHook(() => usePushSubscription())
    expect(result.current.permission).toBe('unsupported')
    expect(result.current.isSubscribed).toBe(false)

    // Restore
    Object.defineProperty(window, 'Notification', { value: orig, configurable: true })
  })

  it('reflects current Notification.permission on init', () => {
    Object.defineProperty(window, 'Notification', {
      value: { permission: 'granted', requestPermission: vi.fn() },
      configurable: true,
    })

    const { result } = renderHook(() => usePushSubscription())
    expect(result.current.permission).toBe('granted')
  })

  it('checks existing subscription on mount', async () => {
    const sub = makeMockSubscription()
    mockPushManager.getSubscription.mockResolvedValue(sub)

    const { result } = renderHook(() => usePushSubscription())

    // Wait for the async effect
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.isSubscribed).toBe(true)
  })

  it('reports not subscribed when no existing subscription', async () => {
    mockPushManager.getSubscription.mockResolvedValue(null)

    const { result } = renderHook(() => usePushSubscription())

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(result.current.isSubscribed).toBe(false)
  })

  describe('subscribe()', () => {
    it('requests permission and subscribes on success', async () => {
      const newSub = makeMockSubscription()
      mockPushManager.subscribe.mockResolvedValue(newSub)
      ;(window.Notification as any).requestPermission = vi.fn().mockResolvedValue('granted')

      const { result } = renderHook(() => usePushSubscription())

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.subscribe()
      })

      expect(success).toBe(true)
      expect(result.current.permission).toBe('granted')
      expect(result.current.isSubscribed).toBe(true)

      // Should have fetched VAPID key
      expect(fetch).toHaveBeenCalledWith('/api/push/vapid-key')

      // Should have posted subscription to server
      expect(fetch).toHaveBeenCalledWith('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'https://push.example.com/sub1',
          keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
        }),
      })
    })

    it('returns false when permission is denied', async () => {
      ;(window.Notification as any).requestPermission = vi.fn().mockResolvedValue('denied')

      const { result } = renderHook(() => usePushSubscription())

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.subscribe()
      })

      expect(success).toBe(false)
      expect(result.current.permission).toBe('denied')
      expect(result.current.isSubscribed).toBe(false)
    })

    it('returns false when VAPID key fetch fails', async () => {
      ;(window.Notification as any).requestPermission = vi.fn().mockResolvedValue('granted')
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }))

      const { result } = renderHook(() => usePushSubscription())

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.subscribe()
      })

      expect(success).toBe(false)
    })

    it('returns false when serviceWorker is unavailable', async () => {
      // Delete serviceWorker so 'serviceWorker' in navigator is false
      const orig = navigator.serviceWorker
      // biome-ignore lint/performance/noDelete: test needs real property removal
      delete (navigator as any).serviceWorker

      const { result } = renderHook(() => usePushSubscription())

      let success: boolean | undefined
      await act(async () => {
        success = await result.current.subscribe()
      })

      expect(success).toBe(false)

      // Restore
      Object.defineProperty(navigator, 'serviceWorker', { value: orig, configurable: true })
    })
  })

  describe('unsubscribe()', () => {
    it('unsubscribes and notifies server', async () => {
      const sub = makeMockSubscription('https://push.example.com/sub-to-remove')
      mockPushManager.getSubscription.mockResolvedValue(sub)

      const { result } = renderHook(() => usePushSubscription())

      // Wait for mount effect to detect existing subscription
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.isSubscribed).toBe(true)

      await act(async () => {
        await result.current.unsubscribe()
      })

      expect(sub.unsubscribe).toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledWith('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example.com/sub-to-remove' }),
      })
      expect(result.current.isSubscribed).toBe(false)
    })

    it('does nothing when no existing subscription', async () => {
      mockPushManager.getSubscription.mockResolvedValue(null)

      const { result } = renderHook(() => usePushSubscription())

      await act(async () => {
        await result.current.unsubscribe()
      })

      // Only the VAPID key fetch (or none) should be called, not unsubscribe
      expect(fetch).not.toHaveBeenCalledWith('/api/push/unsubscribe', expect.anything())
    })
  })
})
