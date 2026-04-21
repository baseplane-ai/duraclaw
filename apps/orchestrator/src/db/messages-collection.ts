/**
 * Messages collection factory — per-sessionId collections backed by
 * `GET /api/sessions/:id/messages` and persisted to OPFS SQLite.
 *
 * Built on `createSyncedCollection` (GH#38 P1.3) so WS-pushed
 * `{type:'synced-collection-delta', collection:'messages:<sessionId>'}`
 * frames drive begin/write/commit on the synced layer, and
 * `onSessionStreamReconnect` re-invalidates the queryKey on WS
 * drop+resume — the factory handles both paths.
 *
 * - Collection id / wire collection: `messages:<sessionId>` (one collection
 *   per SessionDO tab).
 * - Persisted to OPFS SQLite. `schemaVersion: 6` (bumped from 5) so pre-
 *   migration cache rows stamped with the dead `seq` field are dropped on
 *   first load after deploy (B12).
 * - queryFn contract: returns the FULL history for the session. Per TanStack
 *   DB docs the queryFn result is treated as complete state — any
 *   previously-owned row missing from the response is deleted by
 *   `applySuccessfulResult`. A cursor-based partial response therefore
 *   wipes the rest of the transcript, so we always return the full list
 *   here. The framework's `syncMode: 'on-demand'` + `parseLoadSubsetOptions`
 *   is the supported path for incremental loading; we don't need it yet.
 * - Optimistic user turns: `onInsert` POSTs `/api/sessions/:id/messages`
 *   with `{content, clientId, createdAt}`. The server adopts the client
 *   `clientId` as the row's primary id and the client `createdAt`
 *   verbatim so loopback deepEquals reconciles the echo in-place (B7/B14).
 *   The factory handler only forwards plain-text user turns; image/
 *   ContentBlock sends stay on the legacy `connection.call('sendMessage')`
 *   RPC path in `use-coding-agent.ts`. createSyncedCollection forces
 *   `{refetch: false}` on every handler — WS delta frames are the sole
 *   live-update channel, so the framework's post-mutation auto-refetch is
 *   redundant and in combination with a cursor-based queryFn was the
 *   "entire message chain disappears on send" failure mode.
 *
 * The factory memoises per-sessionId so repeat calls with the same key
 * return the same Collection instance. `evictOldMessages` iterates every
 * cached collection.
 */

import {
  onSessionStreamReconnect,
  subscribeSessionStream,
} from '~/features/agent-orch/use-coding-agent'
import { apiUrl } from '~/lib/platform'
import type { SessionMessage, SessionMessagePart } from '~/lib/types'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

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
 * Get-or-create a messages collection for the given `sessionId`.
 *
 * Reads from `GET /api/sessions/:id/messages` on cold-start (empty
 * collection → no cursor params → full history) and on reconnect
 * (derives `sinceCreatedAt`+`sinceId` cursor from the max row). WS
 * delta frames drive live updates through the synced factory's
 * `begin/write/commit` path.
 */
export function createMessagesCollection(sessionId: string): MessagesCollection {
  const cached = collectionsBySession.get(sessionId)
  if (cached) return cached

  const collection = createSyncedCollection<CachedMessage, string>({
    id: `messages:${sessionId}`,
    collection: `messages:${sessionId}`,
    queryKey: ['messages', sessionId] as const,
    getKey: (row) => row.id,
    subscribe: (handler) => subscribeSessionStream(sessionId, handler),
    onReconnect: (handler) => onSessionStreamReconnect(sessionId, handler),
    queryFn: async () => {
      // Full-history fetch. Per TanStack DB docs the queryFn result IS the
      // authoritative snapshot — a partial response would cause
      // `applySuccessfulResult` to delete every previously-owned row not in
      // the response. Return the complete list and let WS delta frames
      // handle incremental live updates.
      const resp = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/messages`))
      if (!resp.ok) {
        throw new Error(`getMessages failed: ${resp.status}`)
      }
      const body = (await resp.json()) as { messages: SessionMessage[] }
      return (body.messages ?? []).map((m) => toCachedMessage(m, sessionId))
    },
    onInsert: async ({ transaction }) => {
      // The factory's onInsert only handles string-content user turns
      // forwarded from `messagesCollection.insert(...)` in
      // `use-coding-agent.ts` → `sendMessage` / `submitDraft`. Image /
      // ContentBlock sends stay on the legacy RPC path and never reach
      // this handler. We extract the flat text from the first text part
      // (the pre-computed parts-from-content transform is symmetric with
      // the server's — see B7/B14).
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
    persistence: persistence ?? null,
    // B12: bump from 5 → 6 so pre-migration OPFS caches carrying the dead
    // `seq` field are dropped on first load after deploy.
    schemaVersion: 6,
  })

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
