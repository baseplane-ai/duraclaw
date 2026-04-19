/**
 * Messages LocalOnlyCollection -- caches chat messages in OPFS SQLite.
 *
 * - Collection key: 'messages'
 * - Persisted to OPFS SQLite (schema version 2)
 * - Cache-behind: messages written after WS delivery
 * - Cache-first: loaded before WS hydration on session open
 * - 30-day age-based eviction
 *
 * NOTE: top-level await `dbReady` so the persisted branch is taken whenever
 * OPFS is available (B-CLIENT-1 — was reading the stale `let persistence`
 * export and silently falling back to in-memory).
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import type { SessionMessagePart } from '~/lib/types'
import { dbReady } from './db-instance'

/** Message stored in the local cache with session context */
export interface CachedMessage {
  id: string
  sessionId: string
  role: string
  parts: SessionMessagePart[]
  createdAt?: Date | string
  /**
   * Frozen turn position for optimistic rows. Set at insert time to
   * `maxServerTurn + 1` so the optimistic message sorts in the correct
   * chronological position rather than at `MAX_SAFE_INTEGER`. Without this,
   * assistant messages that arrive before the server echo sort *above* the
   * optimistic user message, making it "stay behind" at the bottom.
   */
  turnHint?: number
}

const persistence = await dbReady

function createMessagesCollection() {
  const localOpts = localOnlyCollectionOptions<CachedMessage, string>({
    id: 'messages',
    getKey: (item: CachedMessage) => item.id,
  })

  if (persistence) {
    const opts = persistedCollectionOptions({
      ...localOpts,
      persistence,
      schemaVersion: 2,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(localOpts)
}

export const messagesCollection = createMessagesCollection()

/** Evict messages older than 30 days from the local collection */
export function evictOldMessages() {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const cutoff = thirtyDaysAgo.toISOString()

  try {
    const staleKeys: string[] = []
    for (const [key, msg] of messagesCollection as Iterable<[string, CachedMessage]>) {
      const ts = msg.createdAt
        ? typeof msg.createdAt === 'string'
          ? msg.createdAt
          : msg.createdAt.toISOString()
        : undefined
      if (ts && ts < cutoff) {
        staleKeys.push(key)
      }
    }
    if (staleKeys.length > 0) {
      messagesCollection.delete(staleKeys)
    }
  } catch {
    // Collection may not be ready yet
  }
}
