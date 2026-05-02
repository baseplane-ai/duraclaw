/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PushSubscriptionStatus } from './push-subscription-status'

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

// Mock the push subscription hook
const mockSubscribe = vi.fn()
const mockUnsubscribe = vi.fn()
let mockHookReturn = {
  permission: 'prompt' as 'prompt' | 'granted' | 'denied' | 'unsupported',
  isSubscribed: false,
  subscribe: mockSubscribe,
  unsubscribe: mockUnsubscribe,
  error: null as string | null,
}

vi.mock('~/hooks/use-push-subscription', () => ({
  usePushSubscription: () => mockHookReturn,
}))

import { toast } from 'sonner'

const mockToast = vi.mocked(toast)

const inactiveStatus = {
  webSubscribed: false,
  fcmSubscribed: false,
  web: [],
  fcm: [],
}

const activeStatus = {
  webSubscribed: true,
  fcmSubscribed: false,
  web: [
    {
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0',
      created_at: '2026-05-01T12:00:00.000Z',
    },
  ],
  fcm: [],
}

function mockStatusFetch(payload: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('PushSubscriptionStatus', () => {
  beforeEach(() => {
    mockHookReturn = {
      permission: 'prompt',
      isSubscribed: false,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      error: null,
    }
    mockSubscribe.mockReset()
    mockUnsubscribe.mockReset()
    mockToast.success.mockReset()
    mockToast.error.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders Inactive when status reports no subscriptions', async () => {
    mockStatusFetch(inactiveStatus)
    render(<PushSubscriptionStatus />)

    await waitFor(() => {
      expect(screen.getByText('Inactive on this device')).toBeDefined()
    })
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDefined()
  })

  it('renders Active and a device summary when webSubscribed=true', async () => {
    mockStatusFetch(activeStatus)
    render(<PushSubscriptionStatus />)

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeDefined()
    })
    expect(screen.getByText(/Chrome on Linux/)).toBeDefined()
  })

  it('clicking Subscribe calls hook and shows toast on failure', async () => {
    mockStatusFetch(inactiveStatus)
    mockSubscribe.mockResolvedValue(false)
    mockHookReturn.error = 'VAPID key fetch failed (503)'

    render(<PushSubscriptionStatus />)
    const btn = await screen.findByRole('button', { name: 'Subscribe' })

    await act(async () => {
      btn.click()
    })

    expect(mockSubscribe).toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('VAPID key fetch failed (503)')
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it('clicking Subscribe shows success toast and refreshes status on success', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(inactiveStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(activeStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    mockSubscribe.mockResolvedValue(true)

    render(<PushSubscriptionStatus />)
    const btn = await screen.findByRole('button', { name: 'Subscribe' })

    await act(async () => {
      btn.click()
    })

    expect(mockSubscribe).toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith('Push notifications enabled')
    // Initial fetch + refresh fetch
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
