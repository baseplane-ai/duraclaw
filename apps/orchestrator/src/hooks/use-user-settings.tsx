/**
 * useUserSettings -- TanStackDB-backed tab management hook.
 *
 * Local-first: reads from OPFS-persisted collection, mutations are optimistic
 * via createTransaction. Server sync via queryCollection polling.
 * No WebSocket dependency — works offline from OPFS cache.
 *
 * activeTabId is per-browser (localStorage), not server-synced.
 */

import { createTransaction } from '@tanstack/db'
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

  // ── Tab operations (optimistic + server) ─────────────────────

  const addTab = useCallback((project: string, sessionId: string, title?: string) => {
    // Check existing tabs from collection
    const currentTabs = [...(tabsCollection as Iterable<[string, TabItem]>)]
    const bySession = currentTabs.find(([, t]) => t.sessionId === sessionId)
    if (bySession) {
      const [, existing] = bySession
      if (title && title !== existing.title) {
        // Update title optimistically
        const tx = createTransaction({
          mutationFn: async () => {
            await fetch(`/api/user-settings/tabs/${existing.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title }),
            })
          },
        })
        tx.mutate(() => {
          tabsCollection.update(existing.id, (draft) => {
            draft.title = title
          })
        })
      }
      setActiveTabId(existing.id)
      return
    }

    const byProject = currentTabs.find(([, t]) => t.project === project)
    if (byProject) {
      const [, existing] = byProject
      const tx = createTransaction({
        mutationFn: async () => {
          await fetch('/api/user-settings/tabs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project, sessionId, title }),
          })
        },
      })
      tx.mutate(() => {
        tabsCollection.update(existing.id, (draft) => {
          draft.sessionId = sessionId
          draft.title = title || sessionId.slice(0, 12)
        })
      })
      setActiveTabId(existing.id)
      return
    }

    // New tab
    const id = generateId()
    const newTab: TabItem = { id, project, sessionId, title: title || sessionId.slice(0, 12) }
    const tx = createTransaction({
      mutationFn: async () => {
        await fetch('/api/user-settings/tabs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, sessionId, title }),
        })
      },
    })
    tx.mutate(() => {
      tabsCollection.insert(newTab as TabItem & Record<string, unknown>)
    })
    setActiveTabId(id)
  }, [])

  const addNewTab = useCallback((project: string, sessionId: string, title?: string) => {
    const id = generateId()
    const newTab: TabItem = { id, project, sessionId, title: title || sessionId.slice(0, 12) }
    const tx = createTransaction({
      mutationFn: async () => {
        await fetch('/api/user-settings/tabs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'addNew', project, sessionId, title }),
        })
      },
    })
    tx.mutate(() => {
      tabsCollection.insert(newTab as TabItem & Record<string, unknown>)
    })
    setActiveTabId(id)
  }, [])

  const switchTabSession = useCallback((tabId: string, sessionId: string, title?: string) => {
    const tx = createTransaction({
      mutationFn: async () => {
        await fetch('/api/user-settings/tabs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'switch', tabId, sessionId, title }),
        })
      },
    })
    tx.mutate(() => {
      if (tabsCollection.has(tabId)) {
        tabsCollection.update(tabId, (draft) => {
          draft.sessionId = sessionId
          draft.title = title || sessionId.slice(0, 12)
        })
      }
    })
  }, [])

  const removeTab = useCallback((tabId: string) => {
    // Compute next active tab before removing
    const currentTabs = [...(tabsCollection as Iterable<[string, TabItem]>)].map(([, t]) => t)
    const currentActive = readActiveTabId()
    let newActive = currentActive
    if (currentActive === tabId) {
      const idx = currentTabs.findIndex((t) => t.id === tabId)
      const remaining = currentTabs.filter((t) => t.id !== tabId)
      newActive = remaining[Math.min(idx, remaining.length - 1)]?.id ?? null
    }

    const tx = createTransaction({
      mutationFn: async () => {
        await fetch(`/api/user-settings/tabs/${tabId}`, { method: 'DELETE' })
      },
    })
    tx.mutate(() => {
      if (tabsCollection.has(tabId)) {
        tabsCollection.delete([tabId])
      }
    })
    setActiveTabId(newActive)
  }, [])

  const setActiveTab = useCallback((tabId: string) => {
    setActiveTabId(tabId)
  }, [])

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    const tx = createTransaction({
      mutationFn: async () => {
        await fetch(`/api/user-settings/tabs/${tabId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
      },
    })
    tx.mutate(() => {
      if (tabsCollection.has(tabId)) {
        tabsCollection.update(tabId, (draft) => {
          draft.title = title
        })
      }
    })
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

  // ── Drafts (localStorage only, no server) ────────────────────

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
