/**
 * Arc unread SyncedCollection — per-(user, arc) unread counters and
 * per-channel last-read timestamps (GH#152 P1.5 WU-C).
 *
 * Single global collection (one row per arc the user belongs to), not
 * per-arc memoised — a user has bounded membership and the row shape is
 * tiny. Mirrors `arcs-collection.ts`'s shape: cold-load via REST,
 * incremental deltas via the user-stream WS on the `arcUnread` channel.
 *
 * Server-side wiring lives in `apps/orchestrator/src/lib/collab-summary.ts`
 * (`incrementArcUnread` broadcast) and `apps/orchestrator/src/api/index.ts`
 * (`POST /api/arcs/:id/read` clear + broadcast). Both fan a single
 * `update`-shaped row keyed on `${userId}:${arcId}` to the affected
 * user's stream so the client patches in place without a refetch.
 */

import { apiUrl } from '~/lib/platform'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

const persistence = await dbReady

export interface ArcUnreadRow {
  /** Composite key for TanStack DB. Format: `${userId}:${arcId}`. */
  id: string
  userId: string
  arcId: string
  unreadComments: number
  unreadChat: number
  lastReadCommentsAt: string | null
  lastReadChatAt: string | null
}

export const arcUnreadCollection = createSyncedCollection<ArcUnreadRow, string>({
  id: 'arcUnread',
  queryKey: ['arcUnread'] as const,
  syncFrameType: 'arcUnread',
  queryFn: async () => {
    const resp = await fetch(apiUrl('/api/arcs/unread'))
    if (!resp.ok) throw new Error(`GET /api/arcs/unread ${resp.status}`)
    const json = (await resp.json()) as { rows: ArcUnreadRow[] }
    return json.rows ?? []
  },
  getKey: (row) => row.id,
  persistence,
  schemaVersion: 1,
})
