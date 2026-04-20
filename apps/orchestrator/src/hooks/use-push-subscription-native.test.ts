/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the registered listeners so tests can fire them.
const listeners = new Map<string, (arg: unknown) => unknown>()

const mockRequestPermissions = vi.fn()
const mockRegister = vi.fn()
const mockAddListener = vi.fn(async (event: string, cb: (arg: unknown) => unknown) => {
  listeners.set(event, cb)
  return { remove: vi.fn() }
})

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: () => mockRequestPermissions(),
    register: () => mockRegister(),
    addListener: (event: string, cb: (arg: unknown) => unknown) => mockAddListener(event, cb),
  },
}))

import { usePushSubscriptionNative } from './use-push-subscription-native'

describe('usePushSubscriptionNative', () => {
  beforeEach(() => {
    listeners.clear()
    mockRequestPermissions.mockReset()
    mockRegister.mockReset()
    mockAddListener.mockClear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers listeners on mount', async () => {
    renderHook(() => usePushSubscriptionNative())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(mockAddListener).toHaveBeenCalledWith('registration', expect.any(Function))
    expect(mockAddListener).toHaveBeenCalledWith('registrationError', expect.any(Function))
  })

  it('subscribe() requests permissions then registers when granted', async () => {
    mockRequestPermissions.mockResolvedValue({ receive: 'granted' })
    mockRegister.mockResolvedValue(undefined)

    const { result } = renderHook(() => usePushSubscriptionNative())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    let success: boolean | undefined
    await act(async () => {
      success = await result.current.subscribe()
    })

    expect(success).toBe(true)
    expect(mockRequestPermissions).toHaveBeenCalled()
    expect(mockRegister).toHaveBeenCalled()
    expect(result.current.permission).toBe('granted')
  })

  it('subscribe() returns false when permission denied', async () => {
    mockRequestPermissions.mockResolvedValue({ receive: 'denied' })

    const { result } = renderHook(() => usePushSubscriptionNative())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    let success: boolean | undefined
    await act(async () => {
      success = await result.current.subscribe()
    })

    expect(success).toBe(false)
    expect(mockRegister).not.toHaveBeenCalled()
    expect(result.current.permission).toBe('denied')
  })

  it('registration listener POSTs token to /api/push/fcm-subscribe', async () => {
    const { result } = renderHook(() => usePushSubscriptionNative())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const regCb = listeners.get('registration')
    expect(regCb).toBeDefined()

    await act(async () => {
      await regCb?.({ value: 'fcm-token-from-fcm' })
    })

    expect(fetch).toHaveBeenCalledWith('/api/push/fcm-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'fcm-token-from-fcm', platform: 'android' }),
    })
    expect(result.current.isSubscribed).toBe(true)
  })

  it('registrationError listener flips isSubscribed false', async () => {
    const { result } = renderHook(() => usePushSubscriptionNative())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // First simulate a successful registration so isSubscribed=true
    const regCb = listeners.get('registration')
    await act(async () => {
      await regCb?.({ value: 'tok' })
    })
    expect(result.current.isSubscribed).toBe(true)

    const errCb = listeners.get('registrationError')
    await act(async () => {
      await errCb?.({ error: 'boom' })
    })
    expect(result.current.isSubscribed).toBe(false)
  })

  it('unsubscribe() POSTs to /api/push/fcm-unsubscribe with current token', async () => {
    const { result } = renderHook(() => usePushSubscriptionNative())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Establish a token via the registration callback
    const regCb = listeners.get('registration')
    await act(async () => {
      await regCb?.({ value: 'tok-to-remove' })
    })

    vi.mocked(fetch).mockClear()

    await act(async () => {
      await result.current.unsubscribe()
    })

    expect(fetch).toHaveBeenCalledWith('/api/push/fcm-unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-to-remove' }),
    })
    expect(result.current.isSubscribed).toBe(false)
  })

  it('unsubscribe() is a no-op when no token registered', async () => {
    const { result } = renderHook(() => usePushSubscriptionNative())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    vi.mocked(fetch).mockClear()

    await act(async () => {
      await result.current.unsubscribe()
    })

    expect(fetch).not.toHaveBeenCalled()
  })
})
