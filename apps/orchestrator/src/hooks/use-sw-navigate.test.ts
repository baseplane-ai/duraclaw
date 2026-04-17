/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

import { useSwNavigate } from './use-sw-navigate'

describe('useSwNavigate', () => {
  let addSpy: ReturnType<typeof vi.spyOn>
  let removeSpy: ReturnType<typeof vi.spyOn>
  let swHandler: ((event: MessageEvent) => void) | null

  beforeEach(() => {
    mockNavigate.mockClear()
    swHandler = null
    // Provide a fake serviceWorker on navigator.
    const swMock = {
      addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
        if (type === 'message') swHandler = handler
      }),
      removeEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
        if (type === 'message' && swHandler === handler) swHandler = null
      }),
      startMessages: vi.fn(),
    }
    Object.defineProperty(navigator, 'serviceWorker', {
      value: swMock,
      configurable: true,
    })
    addSpy = vi.spyOn(swMock, 'addEventListener')
    removeSpy = vi.spyOn(swMock, 'removeEventListener')
    // Ensure window.location.origin is stable for URL parsing.
    // jsdom default is http://localhost/.
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers a serviceWorker message listener on mount and removes on unmount', () => {
    const { unmount } = renderHook(() => useSwNavigate())
    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function))
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('calls startMessages() to enable the SW message queue', () => {
    renderHook(() => useSwNavigate())
    const sw = navigator.serviceWorker as unknown as { startMessages: ReturnType<typeof vi.fn> }
    expect(sw.startMessages).toHaveBeenCalledTimes(1)
  })

  function fire(data: unknown) {
    expect(swHandler).toBeTruthy()
    swHandler?.({ data } as MessageEvent)
  }

  it('calls navigate for SW_NAVIGATE messages with same-origin URL', () => {
    renderHook(() => useSwNavigate())
    fire({ type: 'SW_NAVIGATE', url: '/?session=abc' })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/',
      search: { session: 'abc' },
      replace: false,
    })
  })

  it('preserves multiple query params', () => {
    renderHook(() => useSwNavigate())
    fire({ type: 'SW_NAVIGATE', url: '/?session=abc&foo=bar' })
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/',
      search: { session: 'abc', foo: 'bar' },
      replace: false,
    })
  })

  it('ignores messages that are not SW_NAVIGATE', () => {
    renderHook(() => useSwNavigate())
    fire({ type: 'something-else', url: '/?session=abc' })
    fire({ url: '/?session=abc' })
    fire('plain string')
    fire(null)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('ignores SW_NAVIGATE with non-string url', () => {
    renderHook(() => useSwNavigate())
    fire({ type: 'SW_NAVIGATE', url: 42 })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('ignores cross-origin targets', () => {
    renderHook(() => useSwNavigate())
    fire({ type: 'SW_NAVIGATE', url: 'https://evil.example/?session=abc' })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('ignores unparseable urls', () => {
    renderHook(() => useSwNavigate())
    fire({ type: 'SW_NAVIGATE', url: 'http://' })
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
