/**
 * Arc mentions SyncedCollection — per-user @-mention inbox feed
 * (GH#152 P1.5 WU-C).
 *
 * Single global collection — one row per @-mention the user has
 * received across all arcs. Mirrors `arcs-collection.ts`'s shape:
 * cold-load via `GET /api/inbox`, incremental deltas via the
 * user-stream WS on the `arcMentions` channel (insert on emit, update
 * on read-stamp).
 *
 * Server-side wiring: `apps/orchestrator/src/lib/collab-summary.ts`
 * (`recordMentions` insert broadcast) and `apps/orchestrator/src/api/index.ts`
 * (`POST /api/inbox/:mentionId/read` + `POST /api/inbox/read-all`).
 */

import { apiUrl } from '~/lib/platform'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

const persistence = await dbReady

export interface ArcMentionRow {
  id: string
  userId: string
  arcId: string
  sourceKind: 'comment' | 'chat'
  sourceId: string
  actorUserId: string
  preview: string
  /** ISO 8601. */
  mentionTs: string
  readAt: string | null
}

export const arcMentionsCollection = createSyncedCollection<ArcMentionRow, string>({
  id: 'arcMentions',
  queryKey: ['arcMentions'] as const,
  syncFrameType: 'arcMentions',
  queryFn: async () => {
    const resp = await fetch(apiUrl('/api/inbox'))
    if (!resp.ok) throw new Error(`GET /api/inbox ${resp.status}`)
    const json = (await resp.json()) as { rows: ArcMentionRow[] }
    return json.rows ?? []
  },
  getKey: (row) => row.id,
  persistence,
  schemaVersion: 1,
})
