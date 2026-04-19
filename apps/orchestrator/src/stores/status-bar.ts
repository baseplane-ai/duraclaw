import { create } from 'zustand'
import type { PrInfo } from '~/lib/types'

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
  onStop: ((reason: string) => void) | null
  onInterrupt: (() => void) | null
  set: (patch: Partial<Omit<StatusBarStore, 'set' | 'clear'>>) => void
  clear: () => void
}
export const useStatusBarStore = create<StatusBarStore>((set) => ({
  onStop: null,
  onInterrupt: null,
  set: (p) => set(p),
  clear: () => set({ onStop: null, onInterrupt: null }),
}))
