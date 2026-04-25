/**
 * useSessionsCollection — TanStackDB-backed session list hook.
 *
 * Sole source of session list data. Cold-starts via `sessionsCollection`
 * queryFn (GET /api/sessions); stays live via `agent_sessions` synced-
 * collection delta frames pushed by `broadcastSessionRow` from the DO and
 * from REST mutation handlers. See spec #37 B10.
 *
 * No backfillFromRest, no focus handler, no reconnect handler here — the
 * synced-collection factory itself registers onUserStreamReconnect to
 * re-invalidate the queryKey on WS resume.
 */

import type { SessionSummary } from '@duraclaw/shared-types'
import { createTransaction } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import type { SessionRecord } from '~/db/session-record'
import { sessionsCollection } from '~/db/sessions-collection'
import { useNotificationWatcher } from '~/hooks/use-notification-watcher'
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

function rowToSessionRecord(row: SessionSummary): SessionRecord {
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
    // `messageSeq` drives `deriveTabDisplayState`'s `completed_unseen`
    // promotion (spec #87) — if we drop it here the tab strip sees
    // `undefined`, folds to -1, and never flips the sky ring even when
    // the server row is far ahead of `lastSeenSeq`.
    messageSeq: row.messageSeq,
    prompt: row.prompt,
    summary: row.summary,
    title: row.title ?? null,
    tag: row.tag ?? null,
    archived: !!row.archived,
    origin: row.origin ?? null,
    agent: row.agent ?? null,
    runnerSessionId: row.runnerSessionId ?? null,
    capabilitiesJson: row.capabilitiesJson ?? null,
    kataMode: row.kataMode ?? null,
    kataIssue: row.kataIssue ?? null,
    kataPhase: row.kataPhase ?? null,
  }
}

export function useSessionsCollection(
  opts: UseSessionsCollectionOptions = {},
): UseSessionsCollectionResult {
  const { includeArchived = false } = opts
  // TanStack DB beta: the collection generic doesn't line up with the
  // NonSingleResult constraint on the useLiveQuery overload. Runtime is
  // correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(sessionsCollection as any)

  const sessions = useMemo(() => {
    if (!data) return [] as SessionRecord[]
    const projected = (data as SessionSummary[]).map(rowToSessionRecord)
    const filtered = includeArchived ? projected : projected.filter((s) => !s.archived)
    // Bucket lastActivity to 5s before comparing + tiebreak by createdAt /
    // id, so rapid concurrent-turn `last_activity` bumps don't leap-frog
    // rows. Keep in sync with `byActivity` in nav-sessions.tsx.
    const ACTIVITY_BUCKET_MS = 5_000
    return filtered.sort((a, b) => {
      // Sessions with real lastActivity (from gateway) sort first, NULLs last
      const aHas = !!a.lastActivity
      const bHas = !!b.lastActivity
      if (aHas !== bHas) return aHas ? -1 : 1
      const aBucket = Math.floor(
        new Date(a.lastActivity ?? a.updatedAt).getTime() / ACTIVITY_BUCKET_MS,
      )
      const bBucket = Math.floor(
        new Date(b.lastActivity ?? b.updatedAt).getTime() / ACTIVITY_BUCKET_MS,
      )
      if (aBucket !== bBucket) return bBucket - aBucket
      const aCreated = new Date(a.createdAt).getTime()
      const bCreated = new Date(b.createdAt).getTime()
      if (aCreated !== bCreated) return bCreated - aCreated
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }, [data, includeArchived])

  useNotificationWatcher(sessions)

  const createSession = useCallback(
    async (input: { id: string; project: string; model: string; prompt: string }) => {
      const tx = createTransaction({
        mutationFn: async () => {
          const resp = await fetch(apiUrl('/api/sessions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(input),
          })
          if (!resp.ok) {
            throw new Error(`Failed to create session: ${resp.status}`)
          }
        },
      })

      // Optimistic insert into the synced collection. Server echo via
      // broadcastSessionRow('insert') reconciles via deep-equals.
      tx.mutate(() => {
        const now = new Date().toISOString()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const coll = sessionsCollection as any
        coll.insert({
          id: input.id,
          userId: null,
          project: input.project,
          status: 'idle',
          model: input.model,
          prompt: input.prompt,
          createdAt: now,
          updatedAt: now,
          archived: false,
        } as SessionSummary)
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
          credentials: 'include',
          body: JSON.stringify(patch),
        })
        if (!resp.ok) {
          throw new Error(`Failed to update session: ${resp.status}`)
        }
      },
    })

    tx.mutate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coll = sessionsCollection as any
      if (coll.has?.(sessionId)) {
        coll.update(sessionId, (draft: SessionSummary) => {
          Object.assign(draft, patch)
        })
      }
    })

    await tx.isPersisted.promise
  }, [])

  const archiveSession = useCallback(
    async (sessionId: string, archived: boolean) => {
      await updateSession(sessionId, { archived: archived ? 1 : 0 })
    },
    [updateSession],
  )

  return {
    sessions,
    isLoading,
    createSession,
    updateSession,
    archiveSession,
  }
}

/**
 * Selector hook — read a single session from the synced collection.
 * Returns undefined if not loaded / not present. Spec #37 B12.
 */
export function useSession(sessionId: string | null | undefined): SessionSummary | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(sessionsCollection as any)
  if (!sessionId || !data) return undefined
  return (data as SessionSummary[]).find((r) => r.id === sessionId)
}
