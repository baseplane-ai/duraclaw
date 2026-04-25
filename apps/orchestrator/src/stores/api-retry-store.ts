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
  clearTimer: ReturnType<typeof setTimeout> | null
  push: (event: ApiRetryEvent) => void
  clear: () => void
}

const AUTO_CLEAR_MS = 30_000

export const useApiRetryStore = create<ApiRetryStore>((set, get) => ({
  current: null,
  clearTimer: null,
  push: (event) => {
    const existing = get().clearTimer
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => set({ current: null, clearTimer: null }), AUTO_CLEAR_MS)
    set({ current: event, clearTimer: t })
  },
  clear: () => {
    const existing = get().clearTimer
    if (existing) clearTimeout(existing)
    set({ current: null, clearTimer: null })
  },
}))
