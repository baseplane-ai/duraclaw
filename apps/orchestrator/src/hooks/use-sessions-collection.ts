/**
 * useSessionsCollection -- TanStackDB-backed session management hook.
 *
 * Drop-in replacement for useAgentOrchSessions with the same interface.
 * Uses useLiveQuery for reactive data and optimistic mutations.
 */

import { createTransaction } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { type SessionRecord, sessionsCollection } from '~/db/sessions-collection'
import { useNotificationWatcher } from '~/hooks/use-notification-watcher'

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

export function useSessionsCollection(): UseSessionsCollectionResult {
  // Pass collection directly to useLiveQuery for reactive subscription.
  // Cast needed because TanStackDB beta generics don't perfectly align
  // with the NonSingleResult constraint on the overload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(sessionsCollection as any)

  const sessions = useMemo(() => {
    if (!data) return [] as SessionRecord[]
    return ([...data] as SessionRecord[])
      .filter((s) => !s.archived)
      .sort((a, b) => {
        // Sessions with real last_activity (from gateway) sort first, NULLs last
        const aHas = !!a.last_activity
        const bHas = !!b.last_activity
        if (aHas !== bHas) return aHas ? -1 : 1
        const aTime = new Date(a.last_activity ?? a.updated_at).getTime()
        const bTime = new Date(b.last_activity ?? b.updated_at).getTime()
        return bTime - aTime
      })
  }, [data])

  useNotificationWatcher(sessions)

  const createSession = useCallback(
    async (input: { id: string; project: string; model: string; prompt: string }) => {
      const now = new Date().toISOString()
      const optimistic: SessionRecord = {
        id: input.id,
        userId: null,
        project: input.project,
        status: 'idle',
        model: input.model,
        created_at: now,
        updated_at: now,
        prompt: input.prompt,
        archived: false,
      }

      const tx = createTransaction({
        mutationFn: async () => {
          const resp = await fetch('/api/sessions', {
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
        sessionsCollection.insert(optimistic as SessionRecord & Record<string, unknown>)
      })

      await tx.isPersisted.promise
    },
    [],
  )

  const updateSession = useCallback(async (sessionId: string, patch: Record<string, unknown>) => {
    const tx = createTransaction({
      mutationFn: async () => {
        const resp = await fetch(`/api/sessions/${sessionId}`, {
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
      sessionsCollection.update(sessionId, (draft) => {
        Object.assign(draft, patch)
      })
    })

    await tx.isPersisted.promise
  }, [])

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    const tx = createTransaction({
      mutationFn: async () => {
        const resp = await fetch(`/api/sessions/${sessionId}`, {
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
      sessionsCollection.update(sessionId, (draft) => {
        draft.archived = archived
      })
    })

    await tx.isPersisted.promise
  }, [])

  const refresh = useCallback(async () => {
    await sessionsCollection.utils.refetch()
  }, [])

  return {
    sessions,
    isLoading,
    createSession,
    updateSession,
    archiveSession,
    refresh,
  }
}
