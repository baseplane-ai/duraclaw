/**
 * useUserSettings -- TanStackDB-backed tab management with live DO sync.
 *
 * Data flow:
 * 1. Collection loads from OPFS cache (instant), then queryFn fetches once
 * 2. Mutations: collection.insert/update/delete → optimistic UI → handlers POST to DO
 * 3. Live sync: useAgent WS receives DO state broadcasts → utils.writeBatch syncs collection
 *
 * activeTabId is per-browser (localStorage), not server-synced.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useAgent } from 'agents/react'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { UserSettingsState } from '~/agents/user-settings-do'
import { type TabItem, tabsCollection } from '~/db/tabs-collection'

// ── Legacy draft cleanup ─────────────────────────────────────────
// P2b removes the old localStorage draft:* + UserSettingsDO drafts
// pipeline. Y.Text on SessionCollabDO is now the source of truth.
// Sweep any stale keys exactly once per page load so users don't
// carry orphaned blobs forward.
//
// Sentinel is keyed in sessionStorage (not localStorage) so tab
// reloads skip the work but a fresh tab still runs the sweep.

const LEGACY_DRAFT_CLEANUP_SENTINEL = '__duraclaw_legacy_draft_cleanup_done'

function cleanupLegacyDrafts() {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') return
  try {
    if (sessionStorage.getItem(LEGACY_DRAFT_CLEANUP_SENTINEL)) return
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('draft:')) toRemove.push(key)
    }
    for (const key of toRemove) {
      localStorage.removeItem(key)
      const tabId = key.slice('draft:'.length)
      console.warn(`[collab] Cleared legacy draft for tab ${tabId}`)
    }
    sessionStorage.setItem(LEGACY_DRAFT_CLEANUP_SENTINEL, '1')
  } catch {
    // Quota or private-browsing — ignore; worst case we warn next load.
  }
}

// Run once at module load, before any React render.
cleanupLegacyDrafts()

// ── tab order in localStorage ────────────────────────────────────
// Per-browser override for tab display order (same pattern as activeTabId).

const TAB_ORDER_KEY = 'duraclaw-tab-order'

function readTabOrder(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function writeTabOrder(ids: string[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(ids))
  } catch {
    // Quota exceeded or private browsing
  }
}

const orderListeners = new Set<() => void>()
let orderSnapshot = readTabOrder()

function subscribeOrder(cb: () => void) {
  orderListeners.add(cb)
  return () => {
    orderListeners.delete(cb)
  }
}

function getOrderSnapshot() {
  return orderSnapshot
}

function setTabOrder(ids: string[]) {
  orderSnapshot = ids
  writeTabOrder(ids)
  for (const cb of orderListeners) cb()
}

// ── activeTabId in localStorage ──────────────────────────────────

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

const activeListeners = new Set<() => void>()
let activeSnapshot = readActiveTabId()

function subscribeActive(cb: () => void) {
  activeListeners.add(cb)
  return () => {
    activeListeners.delete(cb)
  }
}

function getActiveSnapshot() {
  return activeSnapshot
}

function setActiveTabId(id: string | null) {
  activeSnapshot = id
  writeActiveTabId(id)
  for (const cb of activeListeners) cb()
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

// ── localStorage cache for instant first render ──────────────────
// Seed the collection synchronously from localStorage so useLiveQuery
// returns data on the very first render (no flash of empty tab bar).

const TABS_CACHE_KEY = 'agent-tabs'

function seedFromCache() {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(TABS_CACHE_KEY)
    if (!raw) return
    const cached = JSON.parse(raw) as { tabs?: TabItem[]; activeTabId?: string | null }
    if (cached.tabs?.length) {
      // Use writeBatch + writeInsert — bypasses optimistic layer and handlers.
      // These are pre-synced data, not new mutations. queryFn will reconcile
      // with server state when it completes (deletes stale, upserts fresh).
      tabsCollection.utils.writeBatch(() => {
        for (const tab of cached.tabs ?? []) {
          if (!tabsCollection.has(tab.id)) {
            tabsCollection.utils.writeInsert(tab)
          }
        }
      })
    }
    if (cached.activeTabId) {
      setActiveTabId(cached.activeTabId)
    }
  } catch {
    // Ignore corrupt cache
  }
}

function persistToCache(tabs: TabItem[], activeTabId: string | null) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(TABS_CACHE_KEY, JSON.stringify({ tabs, activeTabId }))
  } catch {
    // Quota exceeded or private browsing
  }
}

// Seed on module load — synchronous, before any React render
seedFromCache()

// ── Module-level imperative ref ──────────────────────────────────

interface UserSettingsImperative {
  tabs: TabItem[]
  activeTabId: string | null
  addTab: (project: string, sessionId: string, title?: string) => void
  addNewTab: (project: string, sessionId: string, title?: string) => void
  switchTabSession: (tabId: string, sessionId: string, title?: string) => void
  removeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  updateTabProject: (tabId: string, project: string) => void
  reorderTabs: (orderedIds: string[]) => void
  findTabBySession: (sessionId: string) => TabItem | undefined
  findTabByProject: (project: string) => TabItem | undefined
}

const settingsRef: { current: UserSettingsImperative } = {
  current: {
    tabs: [],
    activeTabId: null,
    addTab: () => {},
    addNewTab: () => {},
    switchTabSession: () => {},
    removeTab: () => {},
    setActiveTab: () => {},
    updateTabTitle: () => {},
    updateTabProject: () => {},
    reorderTabs: () => {},
    findTabBySession: () => undefined,
    findTabByProject: () => undefined,
  },
}

/** Imperative access to current user settings (like zustand getState) */
export function getUserSettings(): UserSettingsImperative {
  return settingsRef.current
}

// ── Hook ─────────────────────────────────────────────────────────

export interface UserSettingsContextValue extends UserSettingsImperative {
  isLoading: boolean
}

export function useUserSettings(): UserSettingsContextValue {
  // ── Live WS invalidation from DO ────────────────────────────────
  // useAgent connects to the UserSettingsDO. On state broadcasts,
  // we invalidate the query so queryFn refetches from the HTTP endpoint.
  // The collection's own reconciliation handles the diff cleanly.
  useAgent<UserSettingsState>({
    agent: 'user-settings-do',
    basePath: 'api/user-settings/ws',
    onStateUpdate: () => {
      tabsCollection.utils.refetch().catch(() => {})
    },
  })

  // ── Collection reactive reads ──────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(tabsCollection as any)

  const allItems = useMemo(() => {
    if (!data) return [] as TabItem[]
    return [...data] as TabItem[]
  }, [data])

  // Apply local tab-order override (per-browser, localStorage-backed).
  const tabOrder = useSyncExternalStore(subscribeOrder, getOrderSnapshot, () => [] as string[])

  const tabs = useMemo(() => {
    if (tabOrder.length === 0) return allItems
    const byId = new Map(allItems.map((t) => [t.id, t]))
    const ordered: TabItem[] = []
    const seen = new Set<string>()
    for (const id of tabOrder) {
      const t = byId.get(id)
      if (t) {
        ordered.push(t)
        seen.add(id)
      }
    }
    // Append any tabs not in the order list (newly created)
    for (const t of allItems) {
      if (!seen.has(t.id)) ordered.push(t)
    }
    return ordered
  }, [allItems, tabOrder])

  const activeTabId = useSyncExternalStore(subscribeActive, getActiveSnapshot, () => null)

  // Persist to localStorage on every change — keeps cache fresh for next cold start
  useEffect(() => {
    if (tabs.length > 0 || activeTabId) {
      persistToCache(tabs, activeTabId)
    }
  }, [tabs, activeTabId])

  // Ref keeps callbacks reading fresh tabs without re-creating them
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  // ── Tab operations — use in-memory tabs list from useLiveQuery ──

  const addTab = useCallback((project: string, sessionId: string, title?: string) => {
    const current = tabsRef.current

    const bySession = current.find((t) => t.sessionId === sessionId)
    if (bySession) {
      if (title && title !== bySession.title) {
        tabsCollection.update(bySession.id, (draft) => {
          draft.title = title
        })
      }
      setActiveTabId(bySession.id)
      return
    }

    const byProject = current.find((t) => t.project === project)
    if (byProject) {
      tabsCollection.update(byProject.id, (draft) => {
        draft.sessionId = sessionId
        draft.title = title || project
      })
      setActiveTabId(byProject.id)
      return
    }

    const id = generateId()
    tabsCollection.insert({
      id,
      project,
      sessionId,
      title: title || project,
    } as TabItem & Record<string, unknown>)
    setActiveTabId(id)
  }, [])

  const addNewTab = useCallback((project: string, sessionId: string, title?: string) => {
    const id = generateId()
    tabsCollection.insert({
      id,
      project,
      sessionId,
      title: title || project,
    } as TabItem & Record<string, unknown>)
    setActiveTabId(id)
  }, [])

  const switchTabSession = useCallback((tabId: string, sessionId: string, title?: string) => {
    if (tabsCollection.has(tabId)) {
      tabsCollection.update(tabId, (draft) => {
        draft.sessionId = sessionId
        if (title) draft.title = title
      })
    }
  }, [])

  const removeTab = useCallback((tabId: string) => {
    const current = tabsRef.current
    const currentActive = readActiveTabId()
    let newActive = currentActive
    if (currentActive === tabId) {
      const idx = current.findIndex((t) => t.id === tabId)
      const remaining = current.filter((t) => t.id !== tabId)
      newActive = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null
    }

    if (tabsCollection.has(tabId)) {
      tabsCollection.delete([tabId])
    }
    setActiveTabId(newActive)
  }, [])

  const setActiveTab = useCallback((tabId: string) => {
    setActiveTabId(tabId)
  }, [])

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    if (tabsCollection.has(tabId)) {
      tabsCollection.update(tabId, (draft) => {
        draft.title = title
      })
    }
  }, [])

  const updateTabProject = useCallback((tabId: string, project: string) => {
    if (tabsCollection.has(tabId)) {
      tabsCollection.update(tabId, (draft) => {
        draft.project = project
      })
    }
  }, [])

  const reorderTabs = useCallback((orderedIds: string[]) => {
    // Optimistic local update (instant)
    setTabOrder(orderedIds)
    // Persist to server
    fetch('/api/user-settings/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reorder', orderedIds }),
    }).catch(() => {})
  }, [])

  const findTabBySession = useCallback(
    (sessionId: string): TabItem | undefined => {
      return tabs.find((t) => t.sessionId === sessionId)
    },
    [tabs],
  )

  const findTabByProject = useCallback(
    (project: string): TabItem | undefined => {
      return tabs.find((t) => t.project === project)
    },
    [tabs],
  )

  // Keep imperative ref in sync
  settingsRef.current = {
    tabs,
    activeTabId,
    addTab,
    addNewTab,
    switchTabSession,
    removeTab,
    setActiveTab,
    updateTabTitle,
    updateTabProject,
    reorderTabs,
    findTabBySession,
    findTabByProject,
  }

  return {
    tabs,
    activeTabId,
    isLoading,
    addTab,
    addNewTab,
    switchTabSession,
    removeTab,
    setActiveTab,
    updateTabTitle,
    updateTabProject,
    reorderTabs,
    findTabBySession,
    findTabByProject,
  }
}
