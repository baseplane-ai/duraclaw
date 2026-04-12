import { create } from 'zustand'

interface WorkspaceStore {
  activeWorkspace: string | null // workspace name, null = "All"
  workspaceProjects: string[] | null // project names in active workspace, null = all
  setWorkspace: (name: string | null, projects: string[] | null) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  activeWorkspace: null,
  workspaceProjects: null,
  setWorkspace: (name, projects) => set({ activeWorkspace: name, workspaceProjects: projects }),
}))
