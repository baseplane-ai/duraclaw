/**
 * User Tabs QueryCollection -- the new D1-backed tab list (B-CLIENT-2).
 *
 * Built on `createSyncedCollection` (GH#32 phase p3) so WS-pushed
 * `user_tabs` delta frames and `onUserStreamReconnect` resyncs are
 * wired by the shared factory. REST handlers still POST/PATCH/DELETE
 * the D1 routes; broadcasts loop back through the user-stream.
 *
 * Row shape matches the D1 `user_tabs` table after p1 / p2 / p3:
 * `{id, userId, sessionId, position, createdAt, deletedAt?}` — the
 * `deletedAt` column is soft-delete bookkeeping (p3) and GET filters
 * deleted rows out, so clients see only live tabs.
 */

import { apiUrl } from '~/lib/platform'
import type { UserTabRow } from '~/lib/types'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

export type TabRow = UserTabRow

const persistence = await dbReady

function createUserTabsCollection() {
  return createSyncedCollection<UserTabRow, string>({
    id: 'user_tabs',
    queryKey: ['user_tabs'] as const,
    syncFrameType: 'user_tabs',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/user-settings/tabs'))
      if (!resp.ok) return [] as UserTabRow[]
      const json = (await resp.json()) as { tabs: UserTabRow[] }
      return json.tabs
    },
    getKey: (item) => item.id,
    persistence,
    schemaVersion: 1,

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
}

export const userTabsCollection = createUserTabsCollection()
