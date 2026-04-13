import { create } from 'zustand'

const STORAGE_KEY = 'session-workspace-filter'

interface WorkspaceStore {
  activeWorkspace: string | null // workspace name, null = "All"
  workspaceProjects: string[] | null // project names in active workspace, null = all
  setWorkspace: (name: string | null, projects: string[] | null) => void
}

function loadPersistedState(): {
  activeWorkspace: string | null
  workspaceProjects: string[] | null
} {
  if (typeof window === 'undefined') return { activeWorkspace: null, workspaceProjects: null }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        activeWorkspace: parsed.activeWorkspace ?? null,
        workspaceProjects: parsed.workspaceProjects ?? null,
      }
    }
  } catch {
    // Ignore parse errors
  }
  return { activeWorkspace: null, workspaceProjects: null }
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  ...loadPersistedState(),
  setWorkspace: (name, projects) => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ activeWorkspace: name, workspaceProjects: projects }),
        )
      } catch {
        // Ignore storage errors
      }
    }
    set({ activeWorkspace: name, workspaceProjects: projects })
  },
}))
