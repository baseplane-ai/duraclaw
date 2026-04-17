/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock use-build-hash
vi.mock('./use-build-hash', () => ({
  useBuildHash: vi.fn(() => ({ stale: false, checkNow: vi.fn() })),
}))

import { useBuildHash } from './use-build-hash'
import { useSwUpdate } from './use-sw-update'

const mockUseBuildHash = vi.mocked(useBuildHash)

describe('useSwUpdate', () => {
  let mockRegistration: {
    waiting: ServiceWorker | null
    installing: ServiceWorker | null
    update: ReturnType<typeof vi.fn>
    addEventListener: ReturnType<typeof vi.fn>
  }
  let registerPromise: Promise<ServiceWorkerRegistration>

  beforeEach(() => {
    mockRegistration = {
      waiting: null,
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
    }
    registerPromise = Promise.resolve(mockRegistration as unknown as ServiceWorkerRegistration)

    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: vi.fn().mockReturnValue(registerPromise),
        controller: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    })

    mockUseBuildHash.mockReturnValue({ stale: false, checkNow: vi.fn() })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with updateAvailable false', () => {
    const { result } = renderHook(() => useSwUpdate())
    expect(result.current.updateAvailable).toBe(false)
  })

  it('registers the service worker on mount', async () => {
    renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('sets updateAvailable when registration.waiting exists on mount', async () => {
    mockRegistration.waiting = {} as ServiceWorker
    const { result } = renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })
    expect(result.current.updateAvailable).toBe(true)
  })

  it('sets updateAvailable when build hash detects staleness', async () => {
    const { rerender, result } = renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })

    mockUseBuildHash.mockReturnValue({ stale: true, checkNow: vi.fn() })
    await act(async () => {
      rerender()
    })
    expect(result.current.updateAvailable).toBe(true)
  })

  it('calls reg.update() when build hash detects staleness', async () => {
    const { rerender } = renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })

    mockUseBuildHash.mockReturnValue({ stale: true, checkNow: vi.fn() })
    await act(async () => {
      rerender()
    })
    expect(mockRegistration.update).toHaveBeenCalled()
  })

  it('applyUpdate sends SKIP_WAITING when waiting worker exists', async () => {
    const postMessage = vi.fn()
    mockRegistration.waiting = { postMessage } as unknown as ServiceWorker

    const { result } = renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })

    act(() => result.current.applyUpdate())
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('applyUpdate falls back to reload when no waiting worker', async () => {
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      configurable: true,
    })

    const { result } = renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })

    act(() => result.current.applyUpdate())
    expect(reloadMock).toHaveBeenCalled()
  })

  it('handles missing serviceWorker gracefully', () => {
    const original = navigator.serviceWorker
    Object.defineProperty(navigator, 'serviceWorker', {
      get: () => undefined,
      configurable: true,
    })
    const { result } = renderHook(() => useSwUpdate())
    expect(result.current.updateAvailable).toBe(false)
    Object.defineProperty(navigator, 'serviceWorker', {
      value: original,
      configurable: true,
    })
  })
})
