/**
 * useUserSettings -- TanStackDB-backed tab management hook.
 *
 * Uses queryCollectionOptions with onInsert/onUpdate/onDelete handlers
 * for automatic optimistic mutations + DO sync. Direct collection
 * mutations (insert/update/delete) trigger handlers automatically.
 *
 * activeTabId is per-browser (localStorage), not server-synced.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
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

// Tiny pub/sub so useSyncExternalStore re-renders on activeTabId changes
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

// ── Helpers ──────────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function collectionTabs(): TabItem[] {
  return [...(tabsCollection as Iterable<[string, TabItem]>)].map(([, t]) => t)
}

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(tabsCollection as any)

  const tabs = useMemo(() => {
    if (!data) return [] as TabItem[]
    return [...data] as TabItem[]
  }, [data])

  const activeTabId = useSyncExternalStore(subscribeActive, getActiveSnapshot, () => null)

  // ── Tab operations — direct collection mutations ─────────────
  // The collection's onInsert/onUpdate/onDelete handlers handle server sync.
  // Mutations are optimistic and auto-rollback on handler failure.

  const addTab = useCallback((project: string, sessionId: string, title?: string) => {
    const current = collectionTabs()

    // Session already has a tab — just activate (update title if needed)
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

    // Project already has a tab — replace its session
    const byProject = current.find((t) => t.project === project)
    if (byProject) {
      tabsCollection.update(byProject.id, (draft) => {
        draft.sessionId = sessionId
        draft.title = title || sessionId.slice(0, 12)
      })
      setActiveTabId(byProject.id)
      return
    }

    // New tab
    const id = generateId()
    tabsCollection.insert({
      id,
      project,
      sessionId,
      title: title || sessionId.slice(0, 12),
    } as TabItem & Record<string, unknown>)
    setActiveTabId(id)
  }, [])

  const addNewTab = useCallback((project: string, sessionId: string, title?: string) => {
    const id = generateId()
    tabsCollection.insert({
      id,
      project,
      sessionId,
      title: title || sessionId.slice(0, 12),
    } as TabItem & Record<string, unknown>)
    setActiveTabId(id)
  }, [])

  const switchTabSession = useCallback((tabId: string, sessionId: string, title?: string) => {
    if (tabsCollection.has(tabId)) {
      tabsCollection.update(tabId, (draft) => {
        draft.sessionId = sessionId
        draft.title = title || sessionId.slice(0, 12)
      })
    }
  }, [])

  const removeTab = useCallback((tabId: string) => {
    const current = collectionTabs()
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

  // ── Drafts (localStorage only) ───────────────────────────────

  const draftTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const saveDraft = useCallback((tabId: string, text: string) => {
    const existing = draftTimerRef.current.get(tabId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      draftTimerRef.current.delete(tabId)
      if (typeof localStorage !== 'undefined') {
        if (text) {
          localStorage.setItem(`draft:${tabId}`, text)
        } else {
          localStorage.removeItem(`draft:${tabId}`)
        }
      }
    }, 500)
    draftTimerRef.current.set(tabId, timer)
  }, [])

  const getDraft = useCallback((tabId: string): string => {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(`draft:${tabId}`) ?? ''
  }, [])

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
