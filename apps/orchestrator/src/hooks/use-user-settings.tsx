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
  saveDraft: (tabId: string, text: string) => void
  getDraft: (tabId: string) => string
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

  // Filter out sentinel draft records (project === '__draft') from visible tabs
  const tabs = useMemo(() => allItems.filter((t) => t.project !== '__draft'), [allItems])

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

  // ── Drafts (synced via collection — debounced update) ────────

  const draftTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const saveDraft = useCallback((tabId: string, text: string) => {
    // Write to localStorage synchronously for instant restore on reload
    if (typeof localStorage !== 'undefined') {
      if (text) {
        localStorage.setItem(`draft:${tabId}`, text)
      } else {
        localStorage.removeItem(`draft:${tabId}`)
      }
    }

    // Cancel any pending debounced write for this tab
    const existing = draftTimerRef.current.get(tabId)
    if (existing) {
      clearTimeout(existing)
      draftTimerRef.current.delete(tabId)
    }

    const applyToCollection = () => {
      if (tabsCollection.has(tabId)) {
        tabsCollection.update(tabId, (draft) => {
          draft.draft = text || undefined
        })
      } else if (text) {
        // Only create sentinel records for non-empty drafts
        tabsCollection.insert({
          id: tabId,
          project: '__draft',
          sessionId: '',
          title: '',
          draft: text,
        } as TabItem & Record<string, unknown>)
      }
    }

    if (!text) {
      // Clears run immediately so submit never leaves a stale draft
      applyToCollection()
    } else {
      // Typing is debounced to avoid excessive DO syncs
      const timer = setTimeout(applyToCollection, 500)
      draftTimerRef.current.set(tabId, timer)
    }
  }, [])

  const getDraft = useCallback(
    (tabId: string): string => {
      // Collection data (synced from DO) takes priority, localStorage is sync fallback
      const fromCollection = allItems.find((t) => t.id === tabId)?.draft
      if (fromCollection) return fromCollection
      if (typeof localStorage !== 'undefined') return localStorage.getItem(`draft:${tabId}`) ?? ''
      return ''
    },
    [allItems],
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
    saveDraft,
    getDraft,
    findTabBySession,
    findTabByProject,
  }
}
