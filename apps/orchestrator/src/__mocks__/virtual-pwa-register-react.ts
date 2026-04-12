import { useState } from 'react'
import { vi } from 'vitest'

export const mockUpdateServiceWorker = vi.fn()

export function useRegisterSW() {
  const needRefresh = useState(false)
  const offlineReady = useState(false)
  return {
    needRefresh,
    offlineReady,
    updateServiceWorker: mockUpdateServiceWorker,
  }
}
