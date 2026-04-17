/**
 * Sessions QueryCollection -- wraps GET /api/sessions with TanStackDB.
 *
 * - Collection key: 'sessions'
 * - Refetch interval: 30s
 * - Stale time: 15s
 * - Persisted to OPFS SQLite (schema version 1)
 * - localStorage seed for instant first render (same pattern as tabs)
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { SessionSummary } from '~/lib/types'
import { persistence, queryClient } from './db-instance'

export interface SessionRecord extends SessionSummary {
  archived: boolean
}

const queryOpts = queryCollectionOptions({
  queryKey: ['sessions'] as const,
  queryFn: async () => {
    const resp = await fetch('/api/sessions')
    const json = (await resp.json()) as { sessions: SessionSummary[] }
    return json.sessions.map(
      (s): SessionRecord => ({ ...s, archived: !!(s as SessionRecord).archived }),
    )
  },
  queryClient,
  getKey: (item: SessionRecord) => item.id,
  refetchInterval: 30_000,
  staleTime: 15_000,
})

function createSessionsCollection() {
  // When persistence is available, wrap with persisted options
  if (persistence) {
    const opts = persistedCollectionOptions({
      ...queryOpts,
      persistence,
      schemaVersion: 1,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(queryOpts)
}

export const sessionsCollection = createSessionsCollection()

// ── localStorage seed for instant first render ──────────────────
// Mirrors the pattern in tabs-collection: on module load, seed from
// localStorage so useLiveQuery returns data on the very first render.
// The queryFn reconciles with the server when it completes.

const SESSIONS_CACHE_KEY = 'duraclaw-sessions'

function seedFromCache() {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE_KEY)
    if (!raw) return
    const cached = JSON.parse(raw) as SessionRecord[]
    if (!Array.isArray(cached) || cached.length === 0) return
    sessionsCollection.utils.writeBatch(() => {
      for (const session of cached) {
        if (!sessionsCollection.has(session.id)) {
          sessionsCollection.utils.writeInsert(session)
        }
      }
    })
  } catch {
    // Ignore corrupt cache
  }
}

seedFromCache()

/** Persist current sessions to localStorage for next cold start. */
export function persistSessionsToCache(sessions: SessionRecord[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SESSIONS_CACHE_KEY, JSON.stringify(sessions))
  } catch {
    // Quota exceeded or private browsing
  }
}

/**
 * Synchronous direct localStorage lookup — bypasses the TanStack DB
 * collection/query layer entirely. Use this in synchronous React init
 * (useState initializers) where collection data may not be available yet.
 */
export function lookupSessionInCache(
  sessionId: string,
): { project: string; title?: string } | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(SESSIONS_CACHE_KEY)
    if (!raw) return null
    const cached = JSON.parse(raw) as SessionRecord[]
    const session = cached.find((s) => s.id === sessionId)
    if (!session?.project) return null
    return { project: session.project, title: session.title ?? undefined }
  } catch {
    return null
  }
}
