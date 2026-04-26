/**
 * GH#102 / spec 102-sdk-peelback B12: transient store driving the
 * `ApiRetryBanner`. Holds the most recent `api_retry` event; cleared by
 * (a) any subsequent non-retry event the wire-event consumer fans into
 * `clear()`, or (b) a 30s auto-timeout, whichever first.
 */

import type { ApiRetryEvent } from '@duraclaw/shared-types'
import { create } from 'zustand'

interface ApiRetryStore {
  current: ApiRetryEvent | null
  push: (event: ApiRetryEvent) => void
  clear: () => void
}

const AUTO_CLEAR_MS = 30_000

// Timer handle is module-private — keeping it out of the zustand state prevents
// spurious re-renders for any subscriber that selects the full state.
let clearTimer: ReturnType<typeof setTimeout> | null = null

export const useApiRetryStore = create<ApiRetryStore>((set) => ({
  current: null,
  push: (event) => {
    if (clearTimer) clearTimeout(clearTimer)
    clearTimer = setTimeout(() => {
      clearTimer = null
      set({ current: null })
    }, AUTO_CLEAR_MS)
    set({ current: event })
  },
  clear: () => {
    if (clearTimer) {
      clearTimeout(clearTimer)
      clearTimer = null
    }
    set({ current: null })
  },
}))
