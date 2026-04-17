/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSwNavigate } from './use-sw-navigate'

// Spy on window.location.assign — the hook performs full-page navigation.
const mockAssign = vi.fn()
// Stash origin so parsed.toString() in the hook produces a predictable value.
Object.defineProperty(window, 'location', {
  configurable: true,
  value: {
    ...window.location,
    origin: 'http://localhost',
    assign: mockAssign,
  },
})

// Mock Cache Storage for the durable pending-nav drain path.
let cacheEntry: string | null = null
const mockCacheMatch = vi.fn(async (_key: string) => {
  if (cacheEntry === null) return undefined
  return { text: async () => cacheEntry } as unknown as Response
})
const mockCacheDelete = vi.fn(async () => {
  cacheEntry = null
  return true
})
const mockCachesOpen = vi.fn(async () => ({
  match: mockCacheMatch,
  delete: mockCacheDelete,
}))
Object.defineProperty(globalThis, 'caches', {
  configurable: true,
  value: { open: mockCachesOpen },
})

// Mock BroadcastChannel
let bcHandler: ((event: MessageEvent) => void) | null = null
const mockBcClose = vi.fn()

class MockBroadcastChannel {
  name: string
  onmessage: ((event: MessageEvent) => void) | null = null
  constructor(name: string) {
    this.name = name
  }
  close() {
    mockBcClose()
    bcHandler = null
  }
}

// Capture the onmessage setter so tests can fire BC messages
const OriginalBC = globalThis.BroadcastChannel
beforeEach(() => {
  globalThis.BroadcastChannel = class extends MockBroadcastChannel {
    constructor(name: string) {
      super(name)
      // Intercept onmessage setter
      const self = this
      Object.defineProperty(this, 'onmessage', {
        set(fn) {
          bcHandler = fn
          Object.defineProperty(self, '_onmessage', { value: fn, writable: true })
        },
        get() {
          return (self as unknown as { _onmessage: unknown })._onmessage
        },
        configurable: true,
      })
    }
  } as unknown as typeof BroadcastChannel
})

afterEach(() => {
  globalThis.BroadcastChannel = OriginalBC
})

describe('useSwNavigate', () => {
  let swHandler: ((event: MessageEvent) => void) | null

  beforeEach(() => {
    mockAssign.mockClear()
    mockBcClose.mockClear()
    mockCacheMatch.mockClear()
    mockCacheDelete.mockClear()
    mockCachesOpen.mockClear()
    cacheEntry = null
    swHandler = null
    bcHandler = null

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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function fireBc(data: unknown) {
    expect(bcHandler).toBeTruthy()
    bcHandler?.({ data } as MessageEvent)
  }

  function fireSw(data: unknown) {
    expect(swHandler).toBeTruthy()
    swHandler?.({ data } as MessageEvent)
  }

  it('installs both BroadcastChannel and postMessage listeners', () => {
    renderHook(() => useSwNavigate())
    expect(bcHandler).toBeTruthy()
    expect(swHandler).toBeTruthy()
  })

  it('cleans up both listeners on unmount', () => {
    const { unmount } = renderHook(() => useSwNavigate())
    unmount()
    expect(mockBcClose).toHaveBeenCalled()
    expect(swHandler).toBeNull() // removeEventListener was called
  })

  it('calls startMessages() for the postMessage fallback', () => {
    renderHook(() => useSwNavigate())
    const sw = navigator.serviceWorker as unknown as { startMessages: ReturnType<typeof vi.fn> }
    expect(sw.startMessages).toHaveBeenCalledTimes(1)
  })

  // --- BroadcastChannel tests (primary) ---

  it('navigates on BroadcastChannel SW_NAVIGATE message', () => {
    renderHook(() => useSwNavigate())
    fireBc({ type: 'SW_NAVIGATE', url: '/?session=abc' })
    expect(mockAssign).toHaveBeenCalledWith('http://localhost/?session=abc')
  })

  it('preserves multiple query params via BroadcastChannel', () => {
    renderHook(() => useSwNavigate())
    fireBc({ type: 'SW_NAVIGATE', url: '/?session=abc&foo=bar' })
    expect(mockAssign).toHaveBeenCalledWith('http://localhost/?session=abc&foo=bar')
  })

  // --- postMessage tests (fallback) ---

  it('navigates on postMessage SW_NAVIGATE message', () => {
    renderHook(() => useSwNavigate())
    fireSw({ type: 'SW_NAVIGATE', url: '/?session=xyz' })
    expect(mockAssign).toHaveBeenCalledWith('http://localhost/?session=xyz')
  })

  // --- deduplication ---

  it('deduplicates when both channels fire the same URL', () => {
    renderHook(() => useSwNavigate())
    fireBc({ type: 'SW_NAVIGATE', url: '/?session=abc' })
    fireSw({ type: 'SW_NAVIGATE', url: '/?session=abc' })
    expect(mockAssign).toHaveBeenCalledTimes(1)
  })

  it('does NOT dedupe different URLs', () => {
    renderHook(() => useSwNavigate())
    fireBc({ type: 'SW_NAVIGATE', url: '/?session=abc' })
    fireBc({ type: 'SW_NAVIGATE', url: '/?session=def' })
    expect(mockAssign).toHaveBeenCalledTimes(2)
  })

  // --- rejection ---

  it('ignores messages that are not SW_NAVIGATE', () => {
    renderHook(() => useSwNavigate())
    fireBc({ type: 'something-else', url: '/?session=abc' })
    fireBc({ url: '/?session=abc' })
    fireSw({ type: 'SKIP_WAITING' })
    expect(mockAssign).not.toHaveBeenCalled()
  })

  it('ignores SW_NAVIGATE with non-string url', () => {
    renderHook(() => useSwNavigate())
    fireBc({ type: 'SW_NAVIGATE', url: 42 })
    expect(mockAssign).not.toHaveBeenCalled()
  })

  it('ignores cross-origin targets', () => {
    renderHook(() => useSwNavigate())
    fireBc({ type: 'SW_NAVIGATE', url: 'https://evil.example/?session=abc' })
    expect(mockAssign).not.toHaveBeenCalled()
  })

  // --- Cache Storage drain (durable channel) ---

  it('drains Cache Storage pending-nav on mount', async () => {
    cacheEntry = '/?session=cache-mount'
    renderHook(() => useSwNavigate())
    // drain is async — let microtasks settle
    await new Promise((r) => setTimeout(r, 0))
    expect(mockAssign).toHaveBeenCalledWith('http://localhost/?session=cache-mount')
    expect(mockCacheDelete).toHaveBeenCalledWith('/pending-nav')
  })

  it('drains Cache Storage pending-nav on visibilitychange → visible', async () => {
    renderHook(() => useSwNavigate())
    await new Promise((r) => setTimeout(r, 0)) // let mount drain (empty) complete
    mockAssign.mockClear()

    cacheEntry = '/?session=cache-visible'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 0))

    expect(mockAssign).toHaveBeenCalledWith('http://localhost/?session=cache-visible')
    expect(mockCacheDelete).toHaveBeenCalledWith('/pending-nav')
  })

  it('does not navigate when Cache Storage is empty on mount', async () => {
    cacheEntry = null
    renderHook(() => useSwNavigate())
    await new Promise((r) => setTimeout(r, 0))
    expect(mockAssign).not.toHaveBeenCalled()
  })

  it('skips visibilitychange drain when document is hidden', async () => {
    renderHook(() => useSwNavigate())
    await new Promise((r) => setTimeout(r, 0))
    mockAssign.mockClear()
    mockCachesOpen.mockClear()

    cacheEntry = '/?session=hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 0))

    expect(mockAssign).not.toHaveBeenCalled()
    expect(mockCachesOpen).not.toHaveBeenCalled()
  })

  it('drains Cache Storage on window focus', async () => {
    renderHook(() => useSwNavigate())
    await new Promise((r) => setTimeout(r, 0))
    mockAssign.mockClear()

    cacheEntry = '/?session=focus-drain'
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 0))

    expect(mockAssign).toHaveBeenCalledWith('http://localhost/?session=focus-drain')
  })
})
