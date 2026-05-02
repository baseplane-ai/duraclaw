/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PushOptInBanner } from './push-opt-in-banner'

// Mock sonner
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

// Mock the hook
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

describe('PushOptInBanner', () => {
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
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the banner when permission is prompt and not dismissed', () => {
    render(<PushOptInBanner />)
    expect(
      screen.getByText('Enable push notifications to know when sessions need input.'),
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined()
  })

  it('renders nothing when already subscribed', () => {
    mockHookReturn.isSubscribed = true
    const { container } = render(<PushOptInBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when permission is denied', () => {
    mockHookReturn.permission = 'denied'
    const { container } = render(<PushOptInBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when unsupported', () => {
    mockHookReturn.permission = 'unsupported'
    const { container } = render(<PushOptInBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when previously dismissed', () => {
    localStorage.setItem('push-prompt-dismissed', 'true')
    const { container } = render(<PushOptInBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('dismisses and persists to localStorage on Dismiss click', async () => {
    render(<PushOptInBanner />)
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' })

    await act(async () => {
      dismissBtn.click()
    })

    expect(localStorage.getItem('push-prompt-dismissed')).toBe('true')
    expect(screen.queryByText('Enable push notifications')).toBeNull()
  })

  it('calls subscribe and shows success toast on Enable click', async () => {
    mockSubscribe.mockResolvedValue(true)
    render(<PushOptInBanner />)
    const enableBtn = screen.getByRole('button', { name: 'Enable' })

    await act(async () => {
      enableBtn.click()
    })

    expect(mockSubscribe).toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith('Notifications enabled')
    expect(localStorage.getItem('push-prompt-dismissed')).toBe('true')
  })

  it('shows error toast when permission is denied after subscribe attempt', async () => {
    mockSubscribe.mockResolvedValue(false)
    // Simulate the browser having denied permission
    Object.defineProperty(window, 'Notification', {
      value: { permission: 'denied' },
      configurable: true,
    })

    render(<PushOptInBanner />)
    const enableBtn = screen.getByRole('button', { name: 'Enable' })

    await act(async () => {
      enableBtn.click()
    })

    expect(mockToast.error).toHaveBeenCalledWith(
      'Notifications blocked — enable in browser settings',
    )
    expect(localStorage.getItem('push-prompt-dismissed')).toBe('true')
  })

  it('does not dismiss when subscribe fails but permission is not denied', async () => {
    mockSubscribe.mockResolvedValue(false)
    Object.defineProperty(window, 'Notification', {
      value: { permission: 'default' },
      configurable: true,
    })

    render(<PushOptInBanner />)
    const enableBtn = screen.getByRole('button', { name: 'Enable' })

    await act(async () => {
      enableBtn.click()
    })

    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).not.toHaveBeenCalled()
    expect(localStorage.getItem('push-prompt-dismissed')).toBeNull()
  })
})
