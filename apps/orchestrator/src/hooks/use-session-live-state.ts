/**
 * useSessionLiveState — unified reader for per-session live state.
 *
 * Wraps `useLiveQuery` on `sessionLiveStateCollection` and filters to the
 * requested sessionId client-side (mirrors the `useMessagesCollection`
 * pattern). Returns nulls when the id is missing or no row exists so
 * components can render without intermediate loading flicker.
 *
 * `isLive` is true when `wsReadyState === 1` (the session's WS bridge is
 * open); components gate "live" affordances (e.g. active status dot,
 * interactive controls) on this.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import {
  type SessionLiveState,
  sessionLiveStateCollection,
} from '~/db/session-live-state-collection'
import type { KataSessionState, SessionState } from '~/lib/types'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'

export interface UseSessionLiveStateResult {
  state: SessionState | null
  contextUsage: ContextUsage | null
  kataState: KataSessionState | null
  worktreeInfo: WorktreeInfo | null
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
  wsReadyState: number | null
  isLive: boolean
}

const EMPTY: UseSessionLiveStateResult = {
  state: null,
  contextUsage: null,
  kataState: null,
  worktreeInfo: null,
  sessionResult: null,
  wsReadyState: null,
  isLive: false,
}

export function useSessionLiveState(
  sessionId: string | null | undefined,
): UseSessionLiveStateResult {
  // TanStack DB beta: the collection generic doesn't line up with the
  // NonSingleResult constraint on the useLiveQuery overload. Runtime is
  // correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery((q) => q.from({ live_state: sessionLiveStateCollection as any }))

  return useMemo<UseSessionLiveStateResult>(() => {
    if (!sessionId || !data) return EMPTY
    const row = (data as unknown as SessionLiveState[]).find((r) => r.id === sessionId)
    if (!row) return EMPTY
    return {
      state: row.state,
      contextUsage: row.contextUsage,
      kataState: row.kataState,
      worktreeInfo: row.worktreeInfo,
      sessionResult: row.sessionResult,
      wsReadyState: row.wsReadyState,
      isLive: row.wsReadyState === 1,
    }
  }, [data, sessionId])
}
