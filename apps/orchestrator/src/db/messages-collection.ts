/**
 * Messages LocalOnlyCollection -- caches chat messages in OPFS SQLite.
 *
 * - Collection key: 'messages'
 * - Persisted to OPFS SQLite (schema version 1)
 * - Cache-behind: messages written after WS delivery
 * - Cache-first: loaded before WS hydration on session open
 * - 30-day age-based eviction
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import type { SessionMessagePart } from '~/lib/types'
import { persistence } from './db-instance'

/** Message stored in the local cache with session context */
export interface CachedMessage {
  id: string
  sessionId: string
  role: string
  parts: SessionMessagePart[]
  createdAt?: Date | string
}

function createMessagesCollection() {
  const localOpts = localOnlyCollectionOptions<CachedMessage, string>({
    id: 'messages',
    getKey: (item: CachedMessage) => item.id,
  })

  if (persistence) {
    const opts = persistedCollectionOptions({
      ...localOpts,
      persistence,
      schemaVersion: 3,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(localOpts)
}

export const messagesCollection = createMessagesCollection()

/**
 * Upsert a message into the collection (insert or update-in-place).
 * Optimistic by default — in-memory state updates synchronously,
 * OPFS persistence happens async in the background.
 */
export function upsertMessage(
  sessionId: string,
  msg: {
    id: string
    role: string
    parts: SessionMessagePart[]
    createdAt?: Date | string
  },
) {
  try {
    messagesCollection.update(msg.id, (draft) => {
      draft.role = msg.role as CachedMessage['role']
      draft.parts = msg.parts
      if (msg.createdAt) draft.createdAt = msg.createdAt
    })
  } catch {
    // Key not found — insert instead
    try {
      messagesCollection.insert({
        id: msg.id,
        sessionId,
        role: msg.role,
        parts: msg.parts,
        createdAt: msg.createdAt,
      } as CachedMessage & Record<string, unknown>)
    } catch {
      // Duplicate key race — ignore
    }
  }
}

/**
 * Remove messages for a session that are NOT in the provided set of IDs.
 * Used after bulk replay / branch navigation to prune stale entries.
 */
export function pruneStaleMessages(sessionId: string, keepIds: Set<string>) {
  try {
    const staleKeys: string[] = []
    for (const [key, msg] of messagesCollection as Iterable<[string, CachedMessage]>) {
      if (msg.sessionId === sessionId && !keepIds.has(key)) {
        staleKeys.push(key)
      }
    }
    if (staleKeys.length > 0) {
      messagesCollection.delete(staleKeys)
    }
  } catch {
    // Collection may not be ready
  }
}

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
