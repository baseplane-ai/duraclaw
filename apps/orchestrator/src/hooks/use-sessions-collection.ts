/**
 * useSessionsCollection -- TanStackDB-backed session management hook.
 *
 * Wraps `sessionLiveStateCollection` (schema v2) as the single render
 * source for the session list. Returns `SessionRecord[]` derived from
 * each live-state row so existing callers (tab-bar, SessionHistory)
 * continue to consume the SessionSummary-shaped projection unchanged.
 */

import type { SessionSummary } from '@duraclaw/shared-types'
import { createTransaction } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  type SessionLiveState,
  seedSessionLiveStateFromSummary,
  sessionLiveStateCollection,
  upsertSessionLiveState,
} from '~/db/session-live-state-collection'
import type { SessionRecord } from '~/db/session-record'
import { useNotificationWatcher } from '~/hooks/use-notification-watcher'
import { onUserStreamReconnect } from '~/hooks/use-user-stream'
import { apiUrl } from '~/lib/platform'

export type { SessionRecord }

export interface UseSessionsCollectionResult {
  sessions: SessionRecord[]
  isLoading: boolean
  createSession: (data: {
    id: string
    project: string
    model: string
    prompt: string
  }) => Promise<void>
  updateSession: (sessionId: string, patch: Record<string, unknown>) => Promise<void>
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>
  refresh: () => Promise<void>
}

export interface UseSessionsCollectionOptions {
  /**
   * Include archived sessions in the returned list. Defaults to false so the
   * sidebar/primary caller keeps its prior behaviour; readers that show
   * historical sessions (tab-bar, SessionHistory, chain preconditions) pass
   * true to see the full set.
   */
  includeArchived?: boolean
}

/**
 * Project a live-state row into the SessionSummary-shaped SessionRecord
 * readers expect. Spec #31 P5 B10: the `state` SessionState blob is gone;
 * all summary fields come from the D1-mirrored top-level columns.
 */
function rowToSessionRecord(row: SessionLiveState): SessionRecord {
  return {
    id: row.id,
    userId: row.userId ?? null,
    project: row.project ?? '',
    status: row.status ?? 'idle',
    model: row.model ?? null,
    createdAt: row.createdAt ?? row.updatedAt,
    updatedAt: row.updatedAt,
    lastActivity: row.lastActivity ?? null,
    durationMs: row.durationMs ?? null,
    totalCostUsd: row.totalCostUsd ?? null,
    numTurns: row.numTurns ?? 0,
    prompt: row.prompt,
    summary: row.summary,
    title: row.title ?? null,
    tag: row.tag ?? null,
    archived: !!row.archived,
    origin: row.origin ?? null,
    agent: row.agent ?? null,
    messageCount: row.messageCount ?? null,
    sdkSessionId: row.sdkSessionId ?? null,
    kataMode: row.kataMode ?? null,
    kataIssue: row.kataIssue ?? null,
    kataPhase: row.kataPhase ?? null,
  }
}

export function useSessionsCollection(
  opts: UseSessionsCollectionOptions = {},
): UseSessionsCollectionResult {
  const { includeArchived = false } = opts
  // Pass collection directly to useLiveQuery for reactive subscription.
  // Cast needed because TanStackDB beta generics don't perfectly align
  // with the NonSingleResult constraint on the overload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(sessionLiveStateCollection as any)

  const sessions = useMemo(() => {
    if (!data) return [] as SessionRecord[]
    const projected = (data as SessionLiveState[]).map(rowToSessionRecord)
    const filtered = includeArchived ? projected : projected.filter((s) => !s.archived)
    return filtered.sort((a, b) => {
      // Sessions with real lastActivity (from gateway) sort first, NULLs last
      const aHas = !!a.lastActivity
      const bHas = !!b.lastActivity
      if (aHas !== bHas) return aHas ? -1 : 1
      const aTime = new Date(a.lastActivity ?? a.updatedAt).getTime()
      const bTime = new Date(b.lastActivity ?? b.updatedAt).getTime()
      return bTime - aTime
    })
  }, [data, includeArchived])

  useNotificationWatcher(sessions)

  const createSession = useCallback(
    async (input: { id: string; project: string; model: string; prompt: string }) => {
      const now = new Date().toISOString()

      const tx = createTransaction({
        mutationFn: async () => {
          const resp = await fetch(apiUrl('/api/sessions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          })
          if (!resp.ok) {
            throw new Error(`Failed to create session: ${resp.status}`)
          }
        },
      })

      tx.mutate(() => {
        upsertSessionLiveState(input.id, {
          project: input.project,
          model: input.model,
          prompt: input.prompt,
          archived: false,
          createdAt: now,
          wsReadyState: 3,
          status: 'idle',
        })
      })

      await tx.isPersisted.promise
    },
    [],
  )

  const updateSession = useCallback(async (sessionId: string, patch: Record<string, unknown>) => {
    const tx = createTransaction({
      mutationFn: async () => {
        const resp = await fetch(apiUrl(`/api/sessions/${sessionId}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!resp.ok) {
          throw new Error(`Failed to update session: ${resp.status}`)
        }
      },
    })

    tx.mutate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coll = sessionLiveStateCollection as any
      if (coll.has?.(sessionId)) {
        coll.update(sessionId, (draft: SessionLiveState) => {
          Object.assign(draft, patch)
        })
      }
    })

    await tx.isPersisted.promise
  }, [])

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    const tx = createTransaction({
      mutationFn: async () => {
        const resp = await fetch(apiUrl(`/api/sessions/${sessionId}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: archived ? 1 : 0 }),
        })
        if (!resp.ok) {
          throw new Error(`Failed to archive session: ${resp.status}`)
        }
      },
    })

    tx.mutate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coll = sessionLiveStateCollection as any
      if (coll.has?.(sessionId)) {
        coll.update(sessionId, (draft: SessionLiveState) => {
          draft.archived = archived
        })
      }
    })

    await tx.isPersisted.promise
  }, [])

  // Fetch sessions from REST and seed the local collection. Used for
  // cold-start (empty OPFS — e.g. Capacitor fresh install) and manual refresh.
  const backfillFromRest = useCallback(async () => {
    try {
      const resp = await fetch(apiUrl('/api/sessions'), {
        headers: { 'Content-Type': 'application/json' },
      })
      if (!resp.ok) return
      const body = (await resp.json()) as { sessions?: SessionSummary[] }
      const summaries = body.sessions
      if (Array.isArray(summaries)) {
        for (const s of summaries) {
          seedSessionLiveStateFromSummary(s as SessionSummary)
        }
      }
    } catch {
      // best-effort — WS will populate on next connection
    }
  }, [])

  // Sync from REST on mount and on WS reconnect. seedSessionLiveStateFromSummary
  // is a patch-merge (Object.assign) so D1-mirrored fields update without
  // clobbering transient live-state fields (contextUsage, kataState, etc.)
  // that are written by use-coding-agent's WS handlers.
  const didMount = useRef(false)
  useEffect(() => {
    if (isLoading) return
    if (!didMount.current) {
      didMount.current = true
      void backfillFromRest()
    }
  }, [isLoading, backfillFromRest])

  // Re-sync from REST after the user-stream WS reconnects (covers
  // disconnects, tab sleep, network changes) and on window re-focus
  // (covers tab switches in multi-client setups).
  useEffect(() => {
    const unsubReconnect = onUserStreamReconnect(() => {
      void backfillFromRest()
    })

    const onFocus = () => void backfillFromRest()
    window.addEventListener('focus', onFocus)

    return () => {
      unsubReconnect()
      window.removeEventListener('focus', onFocus)
    }
  }, [backfillFromRest])

  const refresh = backfillFromRest

  return {
    sessions,
    isLoading,
    createSession,
    updateSession,
    archiveSession,
    refresh,
  }
}
