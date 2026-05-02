/**
 * User Preferences QueryCollection -- single-row settings table (B-CLIENT-2b).
 *
 * Built on `createSyncedCollection` (GH#32 phase p3) so WS-pushed
 * `user_preferences` delta frames and `onUserStreamReconnect` resyncs are
 * wired by the shared factory.
 *
 * Mutations PUT /api/preferences as a single upsert (per the spec — no
 * per-field updates; the API treats the row as one envelope). The
 * collection is keyed on `userId`.
 */

import { apiUrl } from '~/lib/platform'
import type { UserPreferencesRow } from '~/lib/types'
import { getResolvedPersistence } from './db-instance'
import { lazyCollection } from './lazy-collection'
import { createSyncedCollection } from './synced-collection'

export type PreferencesRow = UserPreferencesRow

function createUserPreferencesCollection() {
  return createSyncedCollection<UserPreferencesRow, string>({
    id: 'user_preferences',
    queryKey: ['user_preferences'] as const,
    syncFrameType: 'user_preferences',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/preferences'))
      if (!resp.ok) return [] as UserPreferencesRow[]
      const row = (await resp.json()) as UserPreferencesRow
      return [row]
    },
    getKey: (item) => item.userId,
    persistence: getResolvedPersistence(),
    schemaVersion: 1,

    onInsert: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        const resp = await fetch(apiUrl('/api/preferences'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(m.modified),
        })
        if (!resp.ok) throw new Error(`Preferences upsert failed: ${resp.status}`)
      }
    },

    onUpdate: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        const resp = await fetch(apiUrl('/api/preferences'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(m.modified),
        })
        if (!resp.ok) throw new Error(`Preferences upsert failed: ${resp.status}`)
      }
    },
  })
}

/**
 * GH#164: lifted top-level await for Hermes. Lazy proxy resolves on
 * first property access, which is always post-bootstrap.
 */
export const userPreferencesCollection = lazyCollection(createUserPreferencesCollection)
