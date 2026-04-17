/**
 * Tabs QueryCollection -- synced to UserSettingsDO via HTTP.
 *
 * - Collection key: 'tabs'
 * - Persisted to OPFS SQLite (schema version 1)
 * - queryFn fetches from /api/user-settings/tabs
 * - onInsert/onUpdate/onDelete handlers sync mutations to the DO
 * - Optimistic mutations with automatic rollback on error
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

  onInsert: async ({ transaction }) => {
    const items = transaction.mutations.map((m) => m.modified)
    for (const item of items) {
      await fetch('/api/user-settings/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      })
    }
  },

  onUpdate: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      await fetch(`/api/user-settings/tabs/${m.key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.changes),
      })
    }
  },

  onDelete: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      await fetch(`/api/user-settings/tabs/${m.key}`, { method: 'DELETE' })
    }
  },
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
