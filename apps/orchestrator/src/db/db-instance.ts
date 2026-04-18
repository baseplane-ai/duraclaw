/**
 * TanStackDB persistence instance with OPFS SQLite fallback.
 *
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

type Persistence = Awaited<ReturnType<typeof createBrowserWASQLitePersistence>>

/** Shared QueryClient instance for TanStackDB collections */
export const queryClient = new QueryClient()

async function initPersistence(): Promise<Persistence | null> {
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
