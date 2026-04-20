/**
 * User Tabs QueryCollection -- the new D1-backed tab list (B-CLIENT-2).
 *
 * - Collection id: 'user_tabs'
 * - Persisted to OPFS SQLite (schema version 1)
 * - queryFn fetches the full state from /api/user-settings/tabs
 * - refetchInterval: false (PartyKit invalidation channel pushes freshness)
 * - onInsert/onUpdate/onDelete handlers POST/PATCH/DELETE the DO HTTP routes
 *
 * Row shape matches the D1 `user_tabs` table after p1 / p2:
 * `{id, userId, sessionId, position, createdAt}` — no `project`, `title`, or
 * `draft`. Consumers join with `sessionLiveStateCollection` to derive display
 * fields (project / title) reactively.
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { apiUrl } from '~/lib/platform'
import type { UserTabRow } from '~/lib/types'
import { dbReady, queryClient } from './db-instance'

export type TabRow = UserTabRow

const queryOpts = queryCollectionOptions({
  id: 'user_tabs',
  queryKey: ['user_tabs'] as const,
  queryFn: async () => {
    const resp = await fetch(apiUrl('/api/user-settings/tabs'))
    if (!resp.ok) return [] as UserTabRow[]
    const json = (await resp.json()) as { tabs: UserTabRow[] }
    return json.tabs
  },
  queryClient,
  getKey: (item: UserTabRow) => item.id,
  // No polling — invalidation channel (B-CLIENT-5) pushes refresh signals
  refetchInterval: false,
  staleTime: Number.POSITIVE_INFINITY,

  onInsert: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(apiUrl('/api/user-settings/tabs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.modified),
      })
      if (!resp.ok) throw new Error(`Tab insert failed: ${resp.status}`)
    }
  },

  onUpdate: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(apiUrl(`/api/user-settings/tabs/${m.key}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.changes),
      })
      if (!resp.ok) throw new Error(`Tab update failed: ${resp.status}`)
    }
  },

  onDelete: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch(apiUrl(`/api/user-settings/tabs/${m.key}`), { method: 'DELETE' })
      if (!resp.ok) throw new Error(`Tab delete failed: ${resp.status}`)
    }
  },
})

const persistence = await dbReady

function createUserTabsCollection() {
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

export const userTabsCollection = createUserTabsCollection()
