/**
 * TanStackDB persistence instance with OPFS SQLite (web) or native SQLite
 * (op-sqlite on Expo / Capacitor SQLite on Capacitor) backends.
 *
 * - Capacitor branch: when `isNative()` is true, dynamically imports the
 *   Capacitor adapter so the native plugin is tree-shaken out of the web bundle.
 * - Expo branch: when `isExpoNative()` is true, dynamically imports the
 *   op-sqlite adapter (JSI-backed).
 * - OPFS detection: checks `navigator.storage?.getDirectory` existence
 * - SSR-safe: guards against `typeof navigator === 'undefined'`
 * - Console warning on fallback to memory-only storage
 *
 * Bootstrap contract (post-GH#164):
 *
 *   Both `entry-client.tsx` (web) and `entry-rn.tsx` (native) `await
 *   dbReady` BEFORE mounting React. Collection modules export lazy
 *   proxies (`lazyCollection`) that defer construction to first
 *   property access, and read `getResolvedPersistence()` (sync) inside
 *   the lazy thunk. The thunk runs post-bootstrap, so persistence is
 *   always resolved by then.
 *
 *   This replaces the prior TLA-at-module-scope pattern (`const
 *   persistence = await dbReady` in every collection file). The TLA was
 *   incompatible with Hermes (the React Native engine on Android
 *   release builds), which cannot compile bundles containing
 *   top-level await. See GH#164.
 *
 * NOTE: do NOT export a mutable `let persistence`. The original B-CLIENT-1
 * race had collection modules reading `persistence` at module load — which
 * was always `null` because `dbReady` had not resolved. The current shape
 * (`getResolvedPersistence()` throws if called pre-resolution) makes the
 * invariant violation a loud failure instead of a silent OPFS-disable.
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
 *
 * Both entry points (entry-client.tsx and entry-rn.tsx) `await dbReady`
 * BEFORE mounting React, so by the time any collection is actually
 * touched at runtime, this promise has resolved. Collection modules used
 * to top-level-await this; that broke Hermes (the RN Android release
 * engine, which cannot compile TLA — see GH#164). Now collection modules
 * read the resolved value synchronously via `getResolvedPersistence()`
 * inside their lazy initializer (see `lazy-collection.ts`).
 */
export const dbReady: Promise<Persistence | null> = initPersistence().then((p) => {
  resolvedPersistence = p
  dbReadySettled = true
  return p
})

let resolvedPersistence: Persistence | null = null
let dbReadySettled = false

/**
 * Synchronous accessor for the resolved persistence handle.
 *
 * Throws if called before `dbReady` resolves — collection modules MUST
 * only read this from inside their lazy-init thunk, never at module-
 * eval time. The lazy-collection helper guarantees first invocation is
 * post-bootstrap (which awaits `dbReady`).
 */
export function getResolvedPersistence(): Persistence | null {
  if (!dbReadySettled) {
    throw new Error(
      '[duraclaw-db] getResolvedPersistence() called before dbReady resolved — bootstrap order violation',
    )
  }
  return resolvedPersistence
}

export async function getPersistence(): Promise<Persistence | null> {
  return dbReady
}
