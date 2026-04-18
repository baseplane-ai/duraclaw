/**
 * Shared imperative tab utilities.
 *
 * These are intentionally kept as plain functions (not hooks) because callers
 * like keyboard handlers and spawn flows need synchronous access without
 * re-render churn.
 */

import { userTabsCollection } from '~/db/user-tabs-collection'
import { setActiveTabId } from '~/hooks/use-active-tab'
import type { UserTabRow } from '~/lib/types'

/** Generate a short random tab ID. */
export function newTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

/** Next available position (max + 1, or 0 if empty). */
export function nextPosition(): number {
  const tabs = userTabsCollection.toArray as unknown as UserTabRow[]
  if (tabs.length === 0) return 0
  return Math.max(0, ...tabs.map((t) => t.position)) + 1
}

/**
 * Locate the existing tab for `sessionId`, or insert a fresh one. In both
 * cases the resulting tab is set active. The optimistic insert uses an empty
 * `userId` — the server populates the real value on POST.
 */
export function ensureTabForSession(sessionId: string): string {
  const tabs = userTabsCollection.toArray as unknown as UserTabRow[]
  const existing = tabs.find((t) => t.sessionId === sessionId)
  if (existing) {
    setActiveTabId(existing.id)
    return existing.id
  }
  const id = newTabId()
  userTabsCollection.insert({
    id,
    userId: '',
    sessionId,
    position: nextPosition(),
    createdAt: new Date().toISOString(),
  } as UserTabRow & Record<string, unknown>)
  setActiveTabId(id)
  return id
}
