/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineBanner } from './offline-banner'

describe('OfflineBanner', () => {
  let listeners: Record<string, (() => void)[]>

  beforeEach(() => {
    listeners = {}
    vi.spyOn(window, 'addEventListener').mockImplementation((event, handler) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(handler as () => void)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders nothing when online', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    const { container } = render(<OfflineBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('renders banner when offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    render(<OfflineBanner />)
    expect(screen.getByText('You are offline')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('shows banner when going offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    render(<OfflineBanner />)
    expect(screen.queryByText('You are offline')).toBeNull()

    act(() => {
      for (const handler of listeners.offline ?? []) handler()
    })

    expect(screen.getByText('You are offline')).toBeDefined()
  })

  it('hides banner when coming back online', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    render(<OfflineBanner />)
    expect(screen.getByText('You are offline')).toBeDefined()

    act(() => {
      for (const handler of listeners.online ?? []) handler()
    })

    expect(screen.queryByText('You are offline')).toBeNull()
  })

  it('cleans up event listeners on unmount', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    const { unmount } = render(<OfflineBanner />)
    unmount()
    expect(window.removeEventListener).toHaveBeenCalledWith('offline', expect.any(Function))
    expect(window.removeEventListener).toHaveBeenCalledWith('online', expect.any(Function))
  })
})
