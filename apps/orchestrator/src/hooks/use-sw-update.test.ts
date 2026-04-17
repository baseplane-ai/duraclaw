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
    update: ReturnType<typeof vi.fn>
  }
  let registerPromise: Promise<ServiceWorkerRegistration>

  beforeEach(() => {
    mockRegistration = {
      waiting: null,
      update: vi.fn().mockResolvedValue(undefined),
    }
    registerPromise = Promise.resolve(mockRegistration as unknown as ServiceWorkerRegistration)

    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: vi.fn().mockReturnValue(registerPromise),
      },
      configurable: true,
    })

    mockUseBuildHash.mockReturnValue({ stale: false, checkNow: vi.fn() })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with updateAvailable false when build is fresh', () => {
    const { result } = renderHook(() => useSwUpdate())
    expect(result.current.updateAvailable).toBe(false)
  })

  it('sets updateAvailable true when build hash is stale', () => {
    mockUseBuildHash.mockReturnValue({ stale: true, checkNow: vi.fn() })
    const { result } = renderHook(() => useSwUpdate())
    expect(result.current.updateAvailable).toBe(true)
  })

  it('registers the service worker on mount', async () => {
    renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
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

  it('applyUpdate sends SKIP_WAITING when waiting worker exists then reloads', async () => {
    const postMessage = vi.fn()
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      configurable: true,
    })
    mockRegistration.waiting = { postMessage } as unknown as ServiceWorker

    const { result } = renderHook(() => useSwUpdate())
    await act(async () => {
      await registerPromise
    })

    act(() => result.current.applyUpdate())
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(reloadMock).toHaveBeenCalled()
  })

  it('applyUpdate reloads even without waiting worker', async () => {
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
