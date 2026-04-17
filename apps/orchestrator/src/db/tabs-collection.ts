/**
 * Tabs QueryCollection -- wraps GET /api/user-settings/tabs with TanStackDB.
 *
 * - Collection key: 'tabs'
 * - Refetch interval: 60s (tabs change less often than sessions)
 * - Stale time: 30s
 * - Persisted to OPFS SQLite (schema version 1)
 * - Mutations use createTransaction for optimistic local-first updates
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { persistence, queryClient } from './db-instance'

export interface TabItem {
  id: string
  project: string
  sessionId: string
  title: string
}

const queryOpts = queryCollectionOptions({
  queryKey: ['tabs'] as const,
  queryFn: async () => {
    const resp = await fetch('/api/user-settings/tabs')
    if (!resp.ok) return []
    const json = (await resp.json()) as { tabs: TabItem[] }
    return json.tabs
  },
  queryClient,
  getKey: (item: TabItem) => item.id,
  refetchInterval: 60_000,
  staleTime: 30_000,
})

function createTabsCollection() {
  if (persistence) {
    const opts = persistedCollectionOptions({
      ...queryOpts,
      persistence,
      schemaVersion: 1,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(queryOpts)
}

export const tabsCollection = createTabsCollection()
