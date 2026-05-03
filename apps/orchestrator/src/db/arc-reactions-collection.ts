/**
 * Arc reactions collection factory — per-arcId TanStack DB collection
 * driven by the user-stream WS (GH#152 P1.4 B12).
 *
 * Wire scope: `reactions:<arcId>` (matches `reactionsChannel(arcId)` in
 * `apps/orchestrator/src/agents/arc-collab-do/rpc-reactions.ts`). Every
 * arc member receives the broadcast on their own UserSettingsDO socket
 * via `broadcastArcRoom`, so reactions are user-scoped on the wire —
 * `createSyncedCollection` is the right factory (mirrors
 * `arc-chat-collection.ts`, NOT the per-session WS one used by comments).
 *
 * Cold load uses `GET /api/arcs/:id/reactions` which returns the latest
 * 1000 rows in `created_at DESC` order. Reactions are tiny — a single
 * cold fetch is enough, no cursor / pagination needed today.
 *
 * No `onInsert` — toggling a reaction is a separate REST call
 * (`POST /api/arcs/:id/reactions/toggle`) routed through
 * `useReactionActions`, since the toggle outcome (`added` / `removed`)
 * drives different ops on the server. The WS echo reconciles the
 * canonical row in place via the factory's upsert-by-key logic.
 */

import type { ReactionRow } from '@duraclaw/shared-types'
import { apiUrl } from '~/lib/platform'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

const persistence = await dbReady

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ArcReactionsCollection = any

/** Memoise per-arcId so `useMemo(() => createArcReactionsCollection(id))` is stable. */
const collectionsByArc = new Map<string, ArcReactionsCollection>()

export function createArcReactionsCollection(arcId: string): ArcReactionsCollection {
  const cached = collectionsByArc.get(arcId)
  if (cached) return cached

  const collection = createSyncedCollection<ReactionRow, string>({
    id: `reactions:${arcId}`,
    queryKey: ['arcReactions', arcId] as const,
    collection: `reactions:${arcId}`,
    queryFn: async () => {
      const resp = await fetch(apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/reactions`))
      if (!resp.ok) throw new Error(`GET /api/arcs/${arcId}/reactions ${resp.status}`)
      const json = (await resp.json()) as { reactions: ReactionRow[] }
      return json.reactions ?? []
    },
    getKey: (row) => row.id,
    persistence,
    schemaVersion: 1,
  })
  collectionsByArc.set(arcId, collection)
  return collection
}
