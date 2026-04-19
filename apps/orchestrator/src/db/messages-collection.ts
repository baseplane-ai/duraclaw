/**
 * Messages QueryCollection factory -- per-agentName collections backed by
 * `GET /api/sessions/:id/messages` and persisted to OPFS SQLite.
 *
 * - Collection id: `messages:<agentName>` (one collection per SessionDO tab)
 * - Persisted to OPFS SQLite (schemaVersion 4 — bump from v3; v3 rows re-
 *   hydrate via queryFn on first read, turnHint is silently dropped on first
 *   write. Retired in P3 in favor of `canonical_turn_id` on user rows.)
 * - syncMode: 'on-demand' — queryFn only fires on explicit fetch / first
 *   subscriber. WS snapshots are the push channel; the query is the pull
 *   channel for cold-start and reconnect-with-stale-cache.
 * - refetchInterval: undefined — WS owns live updates, no polling
 * - staleTime: Infinity — snapshots from the DO keep the collection fresh
 * - retry: 1, retryDelay: 500 — matches the old setTimeout(500) ladder
 *
 * The factory memoises per-agentName so repeat calls with the same key
 * return the same Collection instance. `evictOldMessages` iterates every
 * cached collection.
 *
 * NOTE: top-level await `dbReady` so the persisted branch is taken whenever
 * OPFS is available (B-CLIENT-1 — was reading the stale `let persistence`
 * export and silently falling back to in-memory).
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { SessionMessage, SessionMessagePart } from '~/lib/types'
import { dbReady, queryClient } from './db-instance'

/** Message stored in the local cache with session context */
export interface CachedMessage {
  id: string
  sessionId: string
  role: string
  parts: SessionMessagePart[]
  createdAt?: Date | string
  /**
   * Canonical turn ordinal (`usr-N`) for user rows. Populated server-side on
   * user-message persistence; absent on assistant/tool rows. Drives the
   * messages-collection sort-key so user turns stay in monotonic order even
   * as optimistic rows (id=`usr-client-<uuid>`) reconcile with server echoes.
   */
  canonical_turn_id?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MessagesCollection = any

const persistence = await dbReady

/** Memoise per-agentName so useMemo(() => createMessagesCollection(id)) is stable. */
const collectionsByAgent = new Map<string, MessagesCollection>()

/** Map a server SessionMessage → cached row stamped with the session key. */
function toCachedMessage(msg: SessionMessage, sessionId: string): CachedMessage {
  const canonical = (msg as { canonical_turn_id?: string }).canonical_turn_id
  return {
    id: msg.id,
    sessionId,
    role: msg.role,
    parts: msg.parts,
    createdAt: msg.createdAt,
    ...(canonical ? { canonical_turn_id: canonical } : {}),
  }
}

/**
 * Get-or-create a messages collection for the given agentName.
 *
 * The collection reads from `GET /api/sessions/:id/messages` on cold-start
 * (no cached row) and reconnects-with-stale-cache. The `{type:'messages'}`
 * on-connect snapshot from the DO is a latency optimisation that writes
 * directly into the collection, so the queryFn is only the fallback path.
 */
export function createMessagesCollection(agentName: string): MessagesCollection {
  const cached = collectionsByAgent.get(agentName)
  if (cached) return cached

  const queryOpts = queryCollectionOptions({
    id: `messages:${agentName}`,
    queryKey: ['messages', agentName] as const,
    queryFn: async ({ signal }) => {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(agentName)}/messages`, {
        signal,
      })
      if (!resp.ok) {
        // Surface to query so retry/retryDelay kicks in; collection stays empty.
        throw new Error(`getMessages failed: ${resp.status}`)
      }
      const json = (await resp.json()) as { messages: SessionMessage[] }
      return (json.messages ?? []).map((m) => toCachedMessage(m, agentName))
    },
    queryClient,
    getKey: (item: CachedMessage) => item.id,
    syncMode: 'on-demand',
    refetchInterval: undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
    retryDelay: 500,
  })

  let collection: MessagesCollection
  if (persistence) {
    const opts = persistedCollectionOptions({
      ...queryOpts,
      persistence,
      schemaVersion: 4,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collection = createCollection(opts as any)
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collection = createCollection(queryOpts as any)
  }

  collectionsByAgent.set(agentName, collection)
  return collection
}

/**
 * DEPRECATED — legacy singleton stub for any caller that hasn't migrated to
 * the factory yet. Forwards to `createMessagesCollection('__legacy__')`.
 * New code should call `createMessagesCollection(agentName)` directly.
 */
export const messagesCollection = createMessagesCollection('__legacy__')

/** Evict messages older than 30 days across every cached collection. */
export function evictOldMessages() {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const cutoff = thirtyDaysAgo.toISOString()

  for (const collection of collectionsByAgent.values()) {
    try {
      const staleKeys: string[] = []
      for (const [key, msg] of collection as Iterable<[string, CachedMessage]>) {
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
        collection.delete(staleKeys)
      }
    } catch {
      // Collection may not be ready yet; skip.
    }
  }
}
