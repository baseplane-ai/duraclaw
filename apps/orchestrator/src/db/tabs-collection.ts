/**
 * Tabs QueryCollection -- synced to UserSettingsDO via WS + HTTP.
 *
 * - Collection key: 'tabs'
 * - Persisted to OPFS SQLite (schema version 1)
 * - queryFn fetches full state on cold start (no polling — WS pushes updates)
 * - onInsert/onUpdate/onDelete handlers sync mutations to the DO via HTTP
 * - Live sync: WS broadcasts from DO feed utils.writeBatch for server state
 * - Optimistic mutations with automatic rollback on handler error
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
  /** Synced input draft text (debounced save to DO) */
  draft?: string
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
  // No polling — WS pushes live updates via utils.writeBatch
  refetchInterval: false,
  staleTime: Number.POSITIVE_INFINITY,

  onInsert: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch('/api/user-settings/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.modified),
      })
      if (!resp.ok) throw new Error(`Tab insert failed: ${resp.status}`)
    }
  },

  onUpdate: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(`/api/user-settings/tabs/${m.key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.changes),
      })
      if (!resp.ok) throw new Error(`Tab update failed: ${resp.status}`)
    }
  },

  onDelete: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(`/api/user-settings/tabs/${m.key}`, { method: 'DELETE' })
      if (!resp.ok) throw new Error(`Tab delete failed: ${resp.status}`)
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
