/**
 * Agent Sessions QueryCollection -- wraps GET /api/sessions with TanStackDB.
 *
 * - Collection id: 'agent_sessions' (renamed from 'sessions' per B-CLIENT-3)
 * - Persisted to OPFS SQLite (schemaVersion 2 — bump from 1 drops the old
 *   `sessions` table on first cold start; rows repopulated by queryFn)
 * - Refetch interval: 30s
 * - Stale time: 15s
 *
 * NOTE: localStorage seed/persist/lookup helpers were deleted in B-CLIENT-4.
 * OPFS is now the sole first-render cache. Top-level await `dbReady` so the
 * persisted branch is taken whenever OPFS is available.
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { SessionSummary } from '~/lib/types'
import { dbReady, queryClient } from './db-instance'

export interface SessionRecord extends SessionSummary {
  archived: boolean
}

const queryOpts = queryCollectionOptions({
  id: 'agent_sessions',
  queryKey: ['agent_sessions'] as const,
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

const persistence = await dbReady

function createAgentSessionsCollection() {
  if (persistence) {
    const opts = persistedCollectionOptions({
      ...queryOpts,
      persistence,
      schemaVersion: 2,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(queryOpts)
}

export const agentSessionsCollection = createAgentSessionsCollection()
