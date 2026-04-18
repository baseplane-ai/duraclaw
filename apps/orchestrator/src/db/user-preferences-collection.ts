/**
 * User Preferences QueryCollection -- single-row settings table (B-CLIENT-2b).
 *
 * - Collection id: 'user_preferences'
 * - Persisted to OPFS SQLite (schema version 1)
 * - queryFn fetches GET /api/preferences and wraps the row in `[row]`
 *   (single-row collection keyed on userId)
 * - refetchInterval: false (invalidation channel pushes freshness)
 * - Mutations PUT /api/preferences as a single upsert (per the spec — no
 *   per-field updates; the API treats the row as one envelope)
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { UserPreferencesRow } from '~/lib/types'
import { dbReady, queryClient } from './db-instance'

export type PreferencesRow = UserPreferencesRow

const queryOpts = queryCollectionOptions({
  id: 'user_preferences',
  queryKey: ['user_preferences'] as const,
  queryFn: async () => {
    const resp = await fetch('/api/preferences')
    if (!resp.ok) return [] as UserPreferencesRow[]
    const row = (await resp.json()) as UserPreferencesRow
    return [row]
  },
  queryClient,
  getKey: (item: UserPreferencesRow) => item.userId,
  refetchInterval: false,
  staleTime: Number.POSITIVE_INFINITY,

  onInsert: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.modified),
      })
      if (!resp.ok) throw new Error(`Preferences upsert failed: ${resp.status}`)
    }
  },

  onUpdate: async ({ transaction }) => {
    for (const m of transaction.mutations) {
      const resp = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m.modified),
      })
      if (!resp.ok) throw new Error(`Preferences upsert failed: ${resp.status}`)
    }
  },
})

const persistence = await dbReady

function createUserPreferencesCollection() {
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

export const userPreferencesCollection = createUserPreferencesCollection()
