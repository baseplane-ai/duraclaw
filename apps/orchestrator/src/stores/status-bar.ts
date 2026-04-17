import { create } from 'zustand'
import type { KataSessionState, PrInfo, SessionState } from '~/lib/types'

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
}

export interface WorktreeInfo {
  name: string
  branch: string
  dirty: boolean
  ahead: number
  behind: number
  pr: PrInfo | null
}

interface StatusBarStore {
  state: SessionState | null
  wsReadyState: number
  contextUsage: ContextUsage | null
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
  onStop: ((reason: string) => void) | null
  onInterrupt: (() => void) | null
  kataState: KataSessionState | null
  worktreeInfo: WorktreeInfo | null
  set: (patch: Partial<Omit<StatusBarStore, 'set' | 'clear'>>) => void
  clear: () => void
}

export const useStatusBarStore = create<StatusBarStore>((set) => ({
  state: null,
  wsReadyState: 3,
  contextUsage: null,
  sessionResult: null,
  onStop: null,
  onInterrupt: null,
  kataState: null,
  worktreeInfo: null,
  set: (patch) => set(patch),
  clear: () =>
    set({
      state: null,
      wsReadyState: 3,
      contextUsage: null,
      sessionResult: null,
      onStop: null,
      onInterrupt: null,
      kataState: null,
      worktreeInfo: null,
    }),
}))
