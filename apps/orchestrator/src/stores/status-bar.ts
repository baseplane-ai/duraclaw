import { create } from 'zustand'
import type { KataSessionState, SessionState } from '~/lib/types'

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
}

interface StatusBarStore {
  state: SessionState | null
  wsReadyState: number
  contextUsage: ContextUsage | null
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
  onStop: ((reason: string) => void) | null
  onInterrupt: (() => void) | null
  kataState: KataSessionState | null
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
    }),
}))
