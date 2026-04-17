/**
 * Tabs LocalOnlyCollection -- stores tab state in TanStack DB.
 *
 * - Collection key: 'tabs'
 * - Persisted to OPFS SQLite (schema version 1)
 * - Synced from UserSettingsDO via useAgent state updates
 * - Local-only: writes flow through the DO, not direct mutations
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import { persistence } from './db-instance'

export interface TabItem {
  id: string
  project: string
  sessionId: string
  title: string
}

function createTabsCollection() {
  const localOpts = localOnlyCollectionOptions<TabItem, string>({
    id: 'tabs',
    getKey: (item: TabItem) => item.id,
  })

  if (persistence) {
    const opts = persistedCollectionOptions({
      ...localOpts,
      persistence,
      schemaVersion: 1,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(localOpts)
}

export const tabsCollection = createTabsCollection()
