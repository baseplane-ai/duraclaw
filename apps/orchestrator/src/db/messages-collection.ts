/**
 * Messages collection factory — per-sessionId collections driven by the
 * session WS (GH#47).
 *
 * Historically built on `@tanstack/query-db-collection`'s
 * `queryCollectionOptions`, which treats `queryFn` as an authoritative
 * snapshot — fundamentally incompatible with cursor-based incremental
 * fetching, and redundant with the DO's onConnect replay. This module now
 * follows the TanStack DB "collection-options-creator" pattern: build a
 * `CollectionConfig` directly whose `sync.sync` subscribes to the
 * per-session WS stream and applies `synced-collection-delta` frames
 * through `begin / write / commit`.
 *
 * - Cold load: `SessionDO.onConnect` replays `session.getHistory()` as a
 *   `{type:'insert'}` burst on the new client connection — no REST
 *   round-trip. The persisted OPFS cache (via `persistedCollectionOptions`)
 *   is the authoritative pre-WS view.
 * - Reconnect: free resume. WS reopens → DO re-emits history; TanStack
 *   DB's insert→update auto-conversion (61e8b57) keeps idempotent.
 * - Optimistic user turns: `onInsert` POSTs `/api/sessions/:id/messages`
 *   with `{content, clientId, createdAt}` — unchanged. The server adopts
 *   the `clientId` as the row's primary id so the WS echo reconciles in
 *   place via TanStack DB deepEquals.
 * - `markReady()` fires eagerly at sync-start: there is no snapshot to
 *   wait for, and the WS onConnect burst (if any) is delivered shortly
 *   after. Empty-history sessions are ready immediately rather than
 *   hanging on a frame that never arrives.
 *
 * Memoised per-sessionId so repeat `createMessagesCollection(id)` calls
 * return a stable Collection instance (required for `useLiveQuery`
 * identity stability). `evictOldMessages` iterates every cached
 * collection.
 *
 * Schema version stays at 6 — the row shape on the wire is unchanged
 * from the pre-migration collection.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import type { CollectionConfig, SyncConfig } from '@tanstack/db'
import { createCollection } from '@tanstack/db'
import {
  onSessionStreamReconnect,
  subscribeSessionStream,
} from '~/features/agent-orch/use-coding-agent'
import { apiUrl } from '~/lib/platform'
import type { SessionMessagePart } from '~/lib/types'
import { dbReady } from './db-instance'

/** Message stored in the local cache with session context. */
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

/** Memoise per-sessionId so useMemo(() => createMessagesCollection(id)) is stable. */
const collectionsBySession = new Map<string, MessagesCollection>()

/**
 * Build the raw `CollectionConfig` for a messages collection keyed on
 * `sessionId`. Exposed as a separate fn for testing — the factory below
 * composes this with `persistedCollectionOptions` + `createCollection`.
 */
export function messagesCollectionOptions(sessionId: string): CollectionConfig<CachedMessage> {
  const collectionName = `messages:${sessionId}`

  const sync: SyncConfig<CachedMessage>['sync'] = (params) => {
    const { begin, write, commit, markReady, collection } = params

    const unsubFrame = subscribeSessionStream(
      sessionId,
      (frame: SyncedCollectionFrame<unknown>) => {
        if (frame.collection !== collectionName) return
        begin()
        for (const op of frame.ops) {
          if (op.type === 'delete') {
            // `value` is required at the type level; runtime ignores it on delete.
            write({ type: 'delete', key: op.key, value: undefined as never })
            continue
          }
          // TanStack DB's sync layer auto-converts `insert` → `update` when
          // `deepEquals(existingValue, newValue)` holds; on mismatch it
          // throws DuplicateKeySyncError and aborts the rest of the frame.
          // Our wire protocol is upsert-by-key — streaming `partial_assistant`
          // turns re-emit the same row with growing text, and `onConnect`
          // re-sends persisted rows the OPFS cache already has with slightly
          // different values. Convert to `update` whenever the key is already
          // in the collection so writes stay idempotent.
          const row = op.value as CachedMessage
          const hasFn = collection?.has as ((key: string) => boolean) | undefined
          const alreadyPresent =
            op.type === 'insert' && typeof hasFn === 'function' && hasFn.call(collection, row.id)
          write({ type: alreadyPresent ? 'update' : op.type, value: row })
        }
        commit()
      },
    )

    // Reconnect is a no-op: the DO's onConnect replays `getHistory()` as a
    // fresh insert burst on every new WS connection. The insert→update
    // auto-conversion above absorbs the overlap.
    const unsubReconnect = onSessionStreamReconnect(sessionId, () => {})

    // No initial snapshot to wait for — WS delta frames (cold onConnect burst
    // + live deltas) are the sole sync channel. Mark ready eagerly so
    // consumers (useLiveQuery, optimistic mutations) aren't gated on WS
    // state, and empty-history sessions don't hang on a frame that never
    // arrives.
    markReady()

    return () => {
      unsubFrame()
      unsubReconnect()
    }
  }

  return {
    id: collectionName,
    getKey: (row) => row.id,
    sync: { sync },
    onInsert: async ({ transaction }) => {
      // Only string-content user turns forwarded from `messagesCollection.insert(...)`
      // in `use-coding-agent.ts` → `sendMessage` / `submitDraft` reach this
      // handler. Image / ContentBlock sends stay on the legacy RPC path
      // (`connection.call('sendMessage')`) and bypass this mutation channel.
      const row = transaction.mutations[0].modified as CachedMessage & { content?: string }
      const textPart = row.parts.find((p) => p.type === 'text') as
        | { type: 'text'; text: string }
        | undefined
      const content = row.content ?? textPart?.text ?? ''
      const createdAt =
        typeof row.createdAt === 'string'
          ? row.createdAt
          : row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : new Date().toISOString()
      const resp = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, clientId: row.id, createdAt }),
      })
      // 409 = server already has this clientId (idempotent retry). The
      // canonical row is already in D1 and the echo will reconcile.
      if (resp.status === 409) return
      if (!resp.ok) throw new Error(`sendMessage REST ${resp.status}`)
    },
  }
}

/**
 * Get-or-create a messages collection for the given `sessionId`.
 *
 * WS-driven sync: no REST `queryFn`. Cold load is served from the OPFS
 * persisted cache; the DO's onConnect replay populates a fresh collection
 * on first WS attach.
 */
export function createMessagesCollection(sessionId: string): MessagesCollection {
  const cached = collectionsBySession.get(sessionId)
  if (cached) return cached

  const options = messagesCollectionOptions(sessionId)
  const wrapped = persistence
    ? persistedCollectionOptions({
        ...options,
        persistence,
        schemaVersion: 6,
      })
    : options

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collection = createCollection(wrapped as any)
  collectionsBySession.set(sessionId, collection)
  return collection
}

/**
 * DEPRECATED — legacy singleton stub for any caller that hasn't migrated to
 * the factory yet. Forwards to `createMessagesCollection('__legacy__')`.
 * New code should call `createMessagesCollection(sessionId)` directly.
 */
export const messagesCollection = createMessagesCollection('__legacy__')

/** Evict messages older than 30 days across every cached collection. */
export function evictOldMessages() {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const cutoff = thirtyDaysAgo.toISOString()

  for (const collection of collectionsBySession.values()) {
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
