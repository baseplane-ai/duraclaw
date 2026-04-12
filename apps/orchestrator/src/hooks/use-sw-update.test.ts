/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock sonner
vi.mock('sonner', () => ({
  toast: vi.fn(),
}))

const mockToast = vi.mocked(toast)

describe('SW update toast pattern', () => {
  beforeEach(() => {
    mockToast.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Test the exact pattern used in __root.tsx
  function useSwUpdateToast(
    needRefresh: boolean,
    setNeedRefresh: (v: boolean) => void,
    updateServiceWorker: (reload?: boolean) => Promise<void>,
  ) {
    useEffect(() => {
      if (needRefresh) {
        toast('New version available', {
          description: 'Click reload to update the app.',
          action: {
            label: 'Reload',
            onClick: () => updateServiceWorker(true),
          },
          duration: Infinity,
          onDismiss: () => setNeedRefresh(false),
        })
      }
    }, [needRefresh, setNeedRefresh, updateServiceWorker])
  }

  it('does not show toast when no refresh is needed', () => {
    const setNeedRefresh = vi.fn()
    const updateServiceWorker = vi.fn()

    renderHook(() => useSwUpdateToast(false, setNeedRefresh, updateServiceWorker))
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('shows toast when refresh is needed', () => {
    const setNeedRefresh = vi.fn()
    const updateServiceWorker = vi.fn()

    renderHook(() => useSwUpdateToast(true, setNeedRefresh, updateServiceWorker))
    expect(mockToast).toHaveBeenCalledWith(
      'New version available',
      expect.objectContaining({
        description: 'Click reload to update the app.',
        duration: Infinity,
      }),
    )
  })

  it('toast action triggers updateServiceWorker(true)', () => {
    const setNeedRefresh = vi.fn()
    const updateServiceWorker = vi.fn()

    renderHook(() => useSwUpdateToast(true, setNeedRefresh, updateServiceWorker))

    const options = mockToast.mock.calls[0][1] as Record<string, any>
    options.action.onClick()
    expect(updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('toast onDismiss resets needRefresh to false', () => {
    const setNeedRefresh = vi.fn()
    const updateServiceWorker = vi.fn()

    renderHook(() => useSwUpdateToast(true, setNeedRefresh, updateServiceWorker))

    const options = mockToast.mock.calls[0][1] as Record<string, any>
    options.onDismiss()
    expect(setNeedRefresh).toHaveBeenCalledWith(false)
  })
})
