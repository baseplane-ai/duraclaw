import { create } from 'zustand'

interface Tab {
  sessionId: string
  title: string
}

interface TabStore {
  tabs: Tab[]
  activeTabId: string | null
  addTab: (sessionId: string, title?: string) => void
  removeTab: (sessionId: string) => void
  setActiveTab: (sessionId: string) => void
  updateTabTitle: (sessionId: string, title: string) => void
}

function loadTabs(): { tabs: Tab[]; activeTabId: string | null } {
  try {
    const stored = localStorage.getItem('agent-tabs')
    if (stored) return JSON.parse(stored)
  } catch {}
  return { tabs: [], activeTabId: null }
}

function saveTabs(tabs: Tab[], activeTabId: string | null) {
  localStorage.setItem('agent-tabs', JSON.stringify({ tabs, activeTabId }))
}

const initial = loadTabs()

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: initial.tabs,
  activeTabId: initial.activeTabId,
  addTab: (sessionId, title) => {
    const { tabs } = get()
    if (tabs.some((t) => t.sessionId === sessionId)) {
      set({ activeTabId: sessionId })
      saveTabs(tabs, sessionId)
      return
    }
    const newTabs = [...tabs, { sessionId, title: title || sessionId.slice(0, 12) }]
    set({ tabs: newTabs, activeTabId: sessionId })
    saveTabs(newTabs, sessionId)
  },
  removeTab: (sessionId) => {
    const { tabs, activeTabId } = get()
    const newTabs = tabs.filter((t) => t.sessionId !== sessionId)
    let newActive = activeTabId
    if (activeTabId === sessionId) {
      const idx = tabs.findIndex((t) => t.sessionId === sessionId)
      newActive = newTabs[Math.min(idx, newTabs.length - 1)]?.sessionId ?? null
    }
    set({ tabs: newTabs, activeTabId: newActive })
    saveTabs(newTabs, newActive)
  },
  setActiveTab: (sessionId) => {
    const { tabs } = get()
    set({ activeTabId: sessionId })
    saveTabs(tabs, sessionId)
  },
  updateTabTitle: (sessionId, title) => {
    const { tabs, activeTabId } = get()
    const newTabs = tabs.map((t) => (t.sessionId === sessionId ? { ...t, title } : t))
    set({ tabs: newTabs })
    saveTabs(newTabs, activeTabId)
  },
}))
