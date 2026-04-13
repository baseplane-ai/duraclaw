/**
 * TanStackDB persistence instance with OPFS SQLite fallback.
 *
 * - OPFS detection: checks `navigator.storage?.getDirectory` existence
 * - Non-blocking: app renders before DB init completes
 * - SSR-safe: guards against `typeof navigator === 'undefined'`
 * - Console warning on fallback to memory-only storage
 */

import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from '@tanstack/browser-db-sqlite-persistence'
import { QueryClient } from '@tanstack/query-core'

type Persistence = Awaited<ReturnType<typeof createBrowserWASQLitePersistence>>

let persistence: Persistence | null = null

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

    const p = createBrowserWASQLitePersistence({ database })
    return p
  } catch {
    console.warn('[duraclaw-db] OPFS not available, using memory-only storage')
    return null
  }
}

export const dbReady = initPersistence().then((p) => {
  persistence = p
  return p
})

export { persistence }
