/**
 * TanStackDB persistence instance with OPFS SQLite (web) or native SQLite
 * (Capacitor) backends.
 *
 * - Capacitor branch: when `isNative()` is true, dynamically imports the
 *   Capacitor adapter so the native plugin is tree-shaken out of the web bundle.
 * - OPFS detection: checks `navigator.storage?.getDirectory` existence
 * - Blocking: `dbReady` MUST be top-level-awaited by every collection module
 *   so `createCollection` always sees a non-null persistence on the OPFS path.
 * - SSR-safe: guards against `typeof navigator === 'undefined'`
 * - Console warning on fallback to memory-only storage
 *
 * NOTE: do NOT export a mutable `let persistence`. The original race had
 * `sessions-collection.ts` and `tabs-collection.ts` reading `persistence` at
 * module load — which was always `null` because `dbReady` had not resolved.
 * Result: OPFS cache silently disabled. See B-CLIENT-1.
 */

import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from '@tanstack/browser-db-sqlite-persistence'
import { QueryClient } from '@tanstack/query-core'
import { isExpoNative, isNative } from '../lib/platform'

// All three adapters expose the same structural persistence shape; pin the
// alias to the browser adapter's return type to avoid pulling a second copy
// of `@tanstack/db-sqlite-persistence-core` whose types diverge across
// versions.
type Persistence = Awaited<ReturnType<typeof createBrowserWASQLitePersistence>>

/** Shared QueryClient instance for TanStackDB collections */
export const queryClient = new QueryClient()

async function initPersistence(): Promise<Persistence | null> {
  // Expo native target (op-sqlite via JSI). Checked BEFORE the Capacitor
  // branch because Platform.OS !== 'web' on Expo, but VITE_PLATFORM is
  // only 'capacitor' on the Capacitor build — they're disjoint signals.
  if (isExpoNative()) {
    try {
      const { createOpSqliteAdapter } = await import('./persistence-op-sqlite')
      return (await createOpSqliteAdapter()) as unknown as Persistence
    } catch (err) {
      console.warn('[duraclaw-db] op-sqlite init failed', err)
      return null
    }
  }

  if (isNative()) {
    try {
      const { createCapacitorPersistence } = await import('./persistence-capacitor')
      // Capacitor adapter ships its own copy of db-sqlite-persistence-core
      // types; the runtime shape is identical, so cast through `unknown`.
      return (await createCapacitorPersistence()) as unknown as Persistence
    } catch (err) {
      console.warn('[duraclaw-db] Capacitor SQLite init failed', err)
      return null
    }
  }

  if (typeof navigator === 'undefined') return null

  try {
    // OPFS availability check
    await navigator.storage?.getDirectory()

    const database = await openBrowserWASQLiteOPFSDatabase({
      databaseName: 'duraclaw',
    })

    return createBrowserWASQLitePersistence({ database })
  } catch {
    console.warn('[duraclaw-db] OPFS not available, using memory-only storage')
    return null
  }
}

/**
 * Resolved persistence handle (or null if OPFS unavailable).
 * Top-level await this in every collection module so createCollection
 * always sees a non-null persistence on the OPFS path.
 */
export const dbReady: Promise<Persistence | null> = initPersistence()

export async function getPersistence(): Promise<Persistence | null> {
  return dbReady
}
