/**
 * useActiveTab — per-browser activeTabId, backed by localStorage.
 *
 * Extracted from the deleted `use-user-settings.tsx` (#7 p5). Tabs themselves
 * live in `userTabsCollection` (D1-synced). The currently-focused tab is a
 * client-only concept — no server roundtrip — so it stays in localStorage and
 * is exposed via `useSyncExternalStore` for synchronous reads / writes.
 *
 * The storage key (`duraclaw-active-tab`) is preserved verbatim so existing
 * user data continues to work after the hook rename.
 */

import { useSyncExternalStore } from 'react'

const ACTIVE_TAB_KEY = 'duraclaw-active-tab'

function readActiveTabId(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(ACTIVE_TAB_KEY)
}

function writeActiveTabId(id: string | null) {
  if (typeof localStorage === 'undefined') return
  if (id) {
    localStorage.setItem(ACTIVE_TAB_KEY, id)
  } else {
    localStorage.removeItem(ACTIVE_TAB_KEY)
  }
}

const listeners = new Set<() => void>()
let snapshot = readActiveTabId()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot() {
  return snapshot
}

/** Imperative read — safe to call from event handlers without re-rendering. */
export function getActiveTabId(): string | null {
  return snapshot
}

/** Imperative write — updates localStorage and notifies subscribers. */
export function setActiveTabId(id: string | null): void {
  snapshot = id
  writeActiveTabId(id)
  for (const cb of listeners) cb()
}

/** Reactive hook — re-renders the consumer when the active tab changes. */
export function useActiveTab(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null)
}
