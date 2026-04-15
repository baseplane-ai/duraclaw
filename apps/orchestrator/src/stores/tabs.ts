import { create } from 'zustand'

interface Tab {
  id: string // unique tab id (nanoid-style)
  project: string // project name
  sessionId: string // currently displayed session in this tab
  title: string // display title (session summary or prompt preview)
}

interface TabStore {
  tabs: Tab[]
  activeTabId: string | null

  /** Add or replace: if a tab for this project exists, update its session. Otherwise create new tab. */
  addTab: (project: string, sessionId: string, title?: string) => void

  /** Force a new tab even if one exists for this project (used by "new tab" option). */
  addNewTab: (project: string, sessionId: string, title?: string) => void

  /** Switch which session a tab is displaying (from the dropdown). */
  switchTabSession: (tabId: string, sessionId: string, title?: string) => void

  removeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void

  /** Find tab by sessionId (for route-based lookups). */
  findTabBySession: (sessionId: string) => Tab | undefined

  /** Find tab by project (for "add or replace" logic). */
  findTabByProject: (project: string) => Tab | undefined
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function loadTabs(): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const stored = localStorage.getItem('agent-tabs')
    if (stored) {
      const data = JSON.parse(stored)
      // Migrate old format: tabs without `id` or `project` fields
      if (Array.isArray(data.tabs)) {
        const migrated = data.tabs.map((t: Record<string, unknown>) => ({
          id: (t.id as string) || generateId(),
          project: (t.project as string) || 'unknown',
          sessionId: (t.sessionId as string) || (t as Record<string, string>).sessionId || '',
          title: (t.title as string) || '',
        }))
        return { tabs: migrated, activeTabId: data.activeTabId }
      }
      return data
    }
  } catch {}
  return { tabs: [], activeTabId: null }
}

function saveTabs(tabs: Tab[], activeTabId: string | null) {
  localStorage.setItem('agent-tabs', JSON.stringify({ tabs, activeTabId }))
}

const initial = loadTabs()

export type { Tab }

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: initial.tabs,
  activeTabId: initial.activeTabId,

  addTab: (project, sessionId, title) => {
    const { tabs } = get()
    // First check if this session already has a tab
    const existingBySession = tabs.find((t) => t.sessionId === sessionId)
    if (existingBySession) {
      const newTabs =
        title && title !== existingBySession.title
          ? tabs.map((t) => (t.id === existingBySession.id ? { ...t, title } : t))
          : tabs
      set({ tabs: newTabs, activeTabId: existingBySession.id })
      saveTabs(newTabs, existingBySession.id)
      return
    }
    // Check if project already has a tab — replace its session
    const existingByProject = tabs.find((t) => t.project === project)
    if (existingByProject) {
      const newTabs = tabs.map((t) =>
        t.id === existingByProject.id
          ? { ...t, sessionId, title: title || sessionId.slice(0, 12) }
          : t,
      )
      set({ tabs: newTabs, activeTabId: existingByProject.id })
      saveTabs(newTabs, existingByProject.id)
      return
    }
    // New tab for this project
    const id = generateId()
    const newTabs = [...tabs, { id, project, sessionId, title: title || sessionId.slice(0, 12) }]
    set({ tabs: newTabs, activeTabId: id })
    saveTabs(newTabs, id)
  },

  addNewTab: (project, sessionId, title) => {
    const { tabs } = get()
    const id = generateId()
    const newTabs = [...tabs, { id, project, sessionId, title: title || sessionId.slice(0, 12) }]
    set({ tabs: newTabs, activeTabId: id })
    saveTabs(newTabs, id)
  },

  switchTabSession: (tabId, sessionId, title) => {
    const { tabs, activeTabId } = get()
    const newTabs = tabs.map((t) =>
      t.id === tabId ? { ...t, sessionId, title: title || sessionId.slice(0, 12) } : t,
    )
    set({ tabs: newTabs })
    saveTabs(newTabs, activeTabId)
  },

  removeTab: (tabId) => {
    const { tabs, activeTabId } = get()
    const newTabs = tabs.filter((t) => t.id !== tabId)
    let newActive = activeTabId
    if (activeTabId === tabId) {
      const idx = tabs.findIndex((t) => t.id === tabId)
      newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.id ?? null
    }
    set({ tabs: newTabs, activeTabId: newActive })
    saveTabs(newTabs, newActive)
  },

  setActiveTab: (tabId) => {
    const { tabs } = get()
    set({ activeTabId: tabId })
    saveTabs(tabs, tabId)
  },

  updateTabTitle: (tabId, title) => {
    const { tabs, activeTabId } = get()
    const newTabs = tabs.map((t) => (t.id === tabId ? { ...t, title } : t))
    set({ tabs: newTabs })
    saveTabs(newTabs, activeTabId)
  },

  findTabBySession: (sessionId) => {
    return get().tabs.find((t) => t.sessionId === sessionId)
  },

  findTabByProject: (project) => {
    return get().tabs.find((t) => t.project === project)
  },
}))
