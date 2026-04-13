/**
 * Sessions QueryCollection -- wraps GET /api/sessions with TanStackDB.
 *
 * - Collection key: 'sessions'
 * - Refetch interval: 30s
 * - Stale time: 15s
 * - Persisted to OPFS SQLite (schema version 1)
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
