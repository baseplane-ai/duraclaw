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
import type { KataSessionState, SessionStatus } from '~/lib/types'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'

/**
 * Spec #31 P5 B10: narrowed hook return. `state` and `sessionResult` are
 * no longer exposed — active-session callers use `useDerivedStatus` /
 * `useDerivedGate` / message parts instead. Non-active sidebar callers
 * keep reading `status` + summary fields (D1-mirrored) through this hook.
 */
export interface UseSessionLiveStateResult {
  contextUsage: ContextUsage | null
  kataState: KataSessionState | null
  worktreeInfo: WorktreeInfo | null
  wsReadyState: number | null
  isLive: boolean
  /** D1-mirrored session status for sidebar readers. */
  status?: SessionStatus
  // D1-mirrored summary fields (kept for sidebar / tab / status-bar readers).
  project?: string
  model?: string | null
  prompt?: string
  archived?: boolean
  createdAt?: string
  lastActivity?: string | null
  numTurns?: number | null
  totalCostUsd?: number | null
  durationMs?: number | null
  summary?: string
  title?: string | null
  tag?: string | null
  origin?: string | null
  agent?: string | null
  sdkSessionId?: string | null
  kataMode?: string | null
  kataIssue?: number | null
  kataPhase?: string | null
}

const EMPTY: UseSessionLiveStateResult = {
  contextUsage: null,
  kataState: null,
  worktreeInfo: null,
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
      contextUsage: row.contextUsage,
      kataState: row.kataState,
      worktreeInfo: row.worktreeInfo,
      wsReadyState: row.wsReadyState,
      isLive: row.wsReadyState === 1,
      status: row.status,
      project: row.project,
      model: row.model,
      prompt: row.prompt,
      archived: row.archived,
      createdAt: row.createdAt,
      lastActivity: row.lastActivity ?? null,
      numTurns: row.numTurns ?? null,
      totalCostUsd: row.totalCostUsd ?? null,
      durationMs: row.durationMs ?? null,
      summary: row.summary,
      title: row.title ?? null,
      tag: row.tag ?? null,
      origin: row.origin ?? null,
      agent: row.agent ?? null,
      sdkSessionId: row.sdkSessionId ?? null,
      kataMode: row.kataMode ?? null,
      kataIssue: row.kataIssue ?? null,
      kataPhase: row.kataPhase ?? null,
    }
  }, [data, sessionId])
}
