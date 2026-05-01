/**
 * op-sqlite persistence adapter for TanStack DB on the Expo native target.
 *
 * Mirrors the shape of `persistence-capacitor.ts`: opens an op-sqlite
 * connection and wraps it in the `@duraclaw/op-sqlite-tanstack-persistence`
 * adapter that `persistedCollectionOptions` consumes.
 *
 * This module is dynamically imported by `db-instance.ts` ONLY when
 * `Platform.OS !== 'web'` AND we're inside the Expo runtime (Metro), so
 * the op-sqlite JSI bindings are tree-shaken out of the Vite web bundle
 * and the Vite Capacitor bundle alike.
 */

// All imports are dynamic + @vite-ignore so this file never adds a
// resolvable static import to the Vite (web/Capacitor) bundle. It is
// only reachable from db-instance.ts under the `isExpoNative()` branch,
// which Vite-built code never enters at runtime.
export async function createOpSqliteAdapter() {
  const opSqlite = (await import(/* @vite-ignore */ '@op-engineering/op-sqlite')) as {
    open: (opts: { name: string }) => unknown
  }
  const persistenceMod = (await import(
    /* @vite-ignore */ '@duraclaw/op-sqlite-tanstack-persistence'
  )) as { createOpSqlitePersistence: (opts: unknown) => unknown }
  const database = opSqlite.open({ name: 'duraclaw.db' })
  // op-sqlite opens the connection synchronously; no `database.open()`
  // step is needed (unlike the Capacitor SQLite plugin).
  return persistenceMod.createOpSqlitePersistence({
    database,
    schemaMismatchPolicy: 'reset',
  })
}
