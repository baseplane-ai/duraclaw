/**
 * Capacitor (native) SQLite persistence adapter for TanStack DB.
 *
 * Mirrors the shape of `@tanstack/browser-db-sqlite-persistence`: opens a
 * native SQLite connection via `@capacitor-community/sqlite` and wraps it in
 * the persistence interface that `persistedCollectionOptions` consumes.
 *
 * This module is dynamically imported by `db-instance.ts` ONLY when
 * `isNative()` is true, so the Capacitor SQLite plugin is tree-shaken out
 * of the web bundle.
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'
import { createCapacitorSQLitePersistence } from '@tanstack/capacitor-db-sqlite-persistence'

export async function createCapacitorPersistence() {
  const sqlite = new SQLiteConnection(CapacitorSQLite)

  // If a connection from a prior app lifecycle still exists (hot-reload,
  // -r reinstall, or Android process reuse), retrieve it instead of
  // creating a duplicate — createConnection throws "already exists".
  const exists = await sqlite.isConnection('duraclaw', false)
  const database = exists.result
    ? await sqlite.retrieveConnection('duraclaw', false)
    : await sqlite.createConnection('duraclaw', false, 'no-encryption', 1, false)

  await database.open()
  return createCapacitorSQLitePersistence({ database })
}
