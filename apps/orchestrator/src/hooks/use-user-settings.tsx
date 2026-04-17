/**
 * useUserSettings -- connects to the user-scoped UserSettingsDO via agents SDK,
 * syncs tab state into a TanStack DB collection, and exposes tab operations
 * with debounced draft saving.
 *
 * Architecture:
 * - UserSettingsProvider hosts the useAgent connection (mount once at app root)
 * - useUserSettingsContext is the consumer hook for components
 * - getUserSettings() provides imperative access for event handlers/effects
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useAgent } from 'agents/react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import type { TabRecord, UserSettingsState } from '~/agents/user-settings-do'
import { type TabItem, tabsCollection } from '~/db/tabs-collection'

// ── Collection sync ──────────────────────────────────────────────

function syncTabsToCollection(tabs: TabRecord[]) {
  const incoming = new Map(tabs.map((t) => [t.id, t]))

  // Remove tabs that no longer exist
  const toDelete: string[] = []
  for (const [key] of tabsCollection as Iterable<[string, TabItem]>) {
    if (!incoming.has(key)) toDelete.push(key)
  }
  if (toDelete.length > 0) tabsCollection.delete(toDelete)

  // Upsert incoming tabs
  for (const tab of tabs) {
    const item: TabItem = {
      id: tab.id,
      project: tab.project,
      sessionId: tab.sessionId,
      title: tab.title,
    }
    if (tabsCollection.has(tab.id)) {
      tabsCollection.update(tab.id, (draft) => {
        Object.assign(draft, item)
      })
    } else {
      tabsCollection.insert(item as TabItem & Record<string, unknown>)
    }
  }
}

// ── Module-level imperative ref ──────────────────────────────────

interface UserSettingsImperative {
  tabs: TabItem[]
  activeTabId: string | null
  drafts: Record<string, string>
  addTab: (project: string, sessionId: string, title?: string) => void
  addNewTab: (project: string, sessionId: string, title?: string) => void
  switchTabSession: (tabId: string, sessionId: string, title?: string) => void
  removeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  saveDraft: (tabId: string, text: string) => void
  findTabBySession: (sessionId: string) => TabItem | undefined
  findTabByProject: (project: string) => TabItem | undefined
}

const settingsRef: { current: UserSettingsImperative } = {
  current: {
    tabs: [],
    activeTabId: null,
    drafts: {},
    addTab: () => {},
    addNewTab: () => {},
    switchTabSession: () => {},
    removeTab: () => {},
    setActiveTab: () => {},
    updateTabTitle: () => {},
    saveDraft: () => {},
    findTabBySession: () => undefined,
    findTabByProject: () => undefined,
  },
}

/** Imperative access to current user settings (like zustand getState) */
export function getUserSettings(): UserSettingsImperative {
  return settingsRef.current
}

// ── Context ──────────────────────────────────────────────────────

export interface UserSettingsContextValue extends UserSettingsImperative {
  connected: boolean
  getDraft: (tabId: string) => string
}

const UserSettingsCtx = createContext<UserSettingsContextValue | null>(null)

// ── Provider ─────────────────────────────────────────────────────

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const stateRef = useRef<UserSettingsState>({
    tabs: [],
    activeTabId: null,
    drafts: {},
  })

  const agent = useAgent<UserSettingsState>({
    agent: 'user-settings-do',
    basePath: '/api/user-settings',
    onStateUpdate: (state, _source) => {
      stateRef.current = state
      try {
        syncTabsToCollection(state.tabs)
      } catch {
        // Collection may not be ready yet during SSR/init
      }
    },
  })

  // Sync initial state when agent connects
  useEffect(() => {
    if (agent.state) {
      stateRef.current = agent.state
      try {
        syncTabsToCollection(agent.state.tabs)
      } catch {
        // Collection not ready
      }
    }
  }, [agent.state])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(tabsCollection as any)
  const tabs = useMemo(() => {
    if (!data) return [] as TabItem[]
    return [...data] as TabItem[]
  }, [data])

  const activeTabId = agent.state?.activeTabId ?? stateRef.current.activeTabId
  const drafts = agent.state?.drafts ?? stateRef.current.drafts
  const connected = agent.readyState === WebSocket.OPEN

  // ── Debounced draft save ─────────────────────────────────────

  const draftTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const saveDraft = useCallback(
    (tabId: string, text: string) => {
      stateRef.current = {
        ...stateRef.current,
        drafts: { ...stateRef.current.drafts, [tabId]: text },
      }
      const existing = draftTimerRef.current.get(tabId)
      if (existing) clearTimeout(existing)

      const timer = setTimeout(() => {
        draftTimerRef.current.delete(tabId)
        agent.call('saveDraft', [tabId, text]).catch(() => {})
      }, 500)
      draftTimerRef.current.set(tabId, timer)
    },
    [agent],
  )

  useEffect(() => {
    return () => {
      for (const timer of draftTimerRef.current.values()) {
        clearTimeout(timer)
      }
    }
  }, [])

  // ── Tab operations ───────────────────────────────────────────

  const addTab = useCallback(
    (project: string, sessionId: string, title?: string) => {
      agent.call('addTab', [project, sessionId, title]).catch(() => {})
    },
    [agent],
  )

  const addNewTab = useCallback(
    (project: string, sessionId: string, title?: string) => {
      agent.call('addNewTab', [project, sessionId, title]).catch(() => {})
    },
    [agent],
  )

  const switchTabSession = useCallback(
    (tabId: string, sessionId: string, title?: string) => {
      agent.call('switchTabSession', [tabId, sessionId, title]).catch(() => {})
    },
    [agent],
  )

  const removeTab = useCallback(
    (tabId: string) => {
      agent.call('removeTab', [tabId]).catch(() => {})
    },
    [agent],
  )

  const setActiveTab = useCallback(
    (tabId: string) => {
      agent.call('setActiveTab', [tabId]).catch(() => {})
    },
    [agent],
  )

  const updateTabTitle = useCallback(
    (tabId: string, title: string) => {
      agent.call('updateTabTitle', [tabId, title]).catch(() => {})
    },
    [agent],
  )

  const getDraft = useCallback((tabId: string): string => {
    return stateRef.current.drafts[tabId] ?? ''
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
  useEffect(() => {
    settingsRef.current = {
      tabs,
      activeTabId,
      drafts,
      addTab,
      addNewTab,
      switchTabSession,
      removeTab,
      setActiveTab,
      updateTabTitle,
      saveDraft,
      findTabBySession,
      findTabByProject,
    }
  }, [
    tabs,
    activeTabId,
    drafts,
    addTab,
    addNewTab,
    switchTabSession,
    removeTab,
    setActiveTab,
    updateTabTitle,
    saveDraft,
    findTabBySession,
    findTabByProject,
  ])

  const value = useMemo(
    (): UserSettingsContextValue => ({
      tabs,
      activeTabId,
      drafts,
      connected,
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
    }),
    [
      tabs,
      activeTabId,
      drafts,
      connected,
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
    ],
  )

  return <UserSettingsCtx.Provider value={value}>{children}</UserSettingsCtx.Provider>
}

// ── Consumer hook ────────────────────────────────────────────────

export function useUserSettings(): UserSettingsContextValue {
  const ctx = useContext(UserSettingsCtx)
  if (!ctx) {
    throw new Error('useUserSettings must be used within UserSettingsProvider')
  }
  return ctx
}
