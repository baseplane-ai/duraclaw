/**
 * Arc chat collection factory — per-arcId TanStack DB collection driven
 * by the user-stream WS (GH#152 P1.3 WU-D).
 *
 * Wire scope: `arcChat:<arcId>` (matches `chatChannel(arcId)` in
 * `apps/orchestrator/src/agents/arc-collab-do/rpc-chat.ts`). Every arc
 * member receives the broadcast on their own UserSettingsDO socket via
 * `broadcastArcRoom` (`apps/orchestrator/src/lib/broadcast-arc-room.ts`),
 * so chat is user-scoped on the wire — `createSyncedCollection` is the
 * right factory (NOT the per-session WS one used by `comments`).
 *
 * Cold load uses `GET /api/arcs/:id/chat` with no cursor, which returns
 * the newest 200 rows in chronological (`created_at ASC`) order. The
 * user-stream subscribe layer + cold-load `queryFn` together cover the
 * cold-start + reconnect-resync paths via `createSyncedCollection`'s
 * built-in `invalidateQueries` on reconnect.
 *
 * Optimistic-add hook: `onInsert` POSTs to the Hono forwarder with the
 * mint-side `clientChatId` so the server-side idempotency path returns
 * 409 on retry. Throwing from `onInsert` rolls back the optimistic row;
 * the WS echo reconciles the canonical row in place via the factory's
 * upsert-by-key logic.
 */

import type { ChatMessageRow } from '@duraclaw/shared-types'
import { apiUrl } from '~/lib/platform'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

const persistence = await dbReady

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArcChatCollection = any

/** Memoise per-arcId so `useMemo(() => createArcChatCollection(id))` is stable. */
const collectionsByArc = new Map<string, ArcChatCollection>()

export function createArcChatCollection(arcId: string): ArcChatCollection {
  const cached = collectionsByArc.get(arcId)
  if (cached) return cached

  const collection = createSyncedCollection<ChatMessageRow, string>({
    id: `arcChat:${arcId}`,
    queryKey: ['arcChat', arcId] as const,
    collection: `arcChat:${arcId}`,
    queryFn: async () => {
      const resp = await fetch(apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/chat`))
      if (!resp.ok) throw new Error(`GET /api/arcs/${arcId}/chat ${resp.status}`)
      const json = (await resp.json()) as { chat: ChatMessageRow[] }
      return json.chat ?? []
    },
    getKey: (row) => row.id,
    onInsert: async ({ transaction }) => {
      const row = transaction.mutations[0].modified as ChatMessageRow
      const resp = await fetch(apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/chat`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: row.body, clientChatId: row.id }),
      })
      // 409 = server already accepted this clientChatId (idempotent
      // retry). Canonical row is in the DO already; WS echo reconciles.
      if (resp.status === 409) return
      if (!resp.ok) {
        let errMsg = `addChat ${resp.status}`
        try {
          const j = (await resp.json()) as { error?: string }
          if (j?.error) errMsg = j.error
        } catch {
          // Non-JSON body; keep status-only message.
        }
        throw new Error(errMsg)
      }
    },
    persistence,
    schemaVersion: 1,
  })
  collectionsByArc.set(arcId, collection)
  return collection
}
