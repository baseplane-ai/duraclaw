/**
 * Arcs SyncedCollection — wraps GET /api/arcs with TanStack DB and
 * subscribes to `arcs` delta frames pushed by UserSettingsDO.
 *
 * GH#116 P1.3: renamed from `chains-collection.ts`. The `id`, `queryKey`,
 * and `syncFrameType` flipped from `'chains'` → `'arcs'` so the OPFS
 * persistence shard is per-arc-collection (the old `'chains'` shard
 * becomes orphaned but harmless — TanStack DB's persistence is keyed by
 * collection id). `getKey` now keys on the arc's text id (not the
 * issueNumber) since arcs are no longer 1:1 with GitHub issues.
 *
 * Data flow (post-#116):
 *
 *   SessionDO.syncKataAllToD1 → D1 agent_sessions
 *        ↓
 *     buildArcRow(env, db, userId, arcId) → ArcSummary | null
 *        ↓
 *     broadcastSyncedDelta(env, userId, 'arcs', [op]) → WS frame
 *        ↓
 *     createSyncedCollection sync wrap → begin/write/commit
 *
 * Read-only from the user's perspective — no optimistic onInsert/onUpdate/
 * onDelete handlers; authoritative writes happen server-side via the
 * `/api/arcs/*` endpoints (P3) and SessionDO lifecycle events.
 */

import { apiUrl } from '~/lib/platform'
import type { ArcSummary } from '~/lib/types'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

const persistence = await dbReady

function createArcsCollection() {
  return createSyncedCollection<ArcSummary, string>({
    id: 'arcs',
    queryKey: ['arcs'] as const,
    syncFrameType: 'arcs',
    queryFn: async () => {
      const resp = await fetch(apiUrl('/api/arcs'))
      if (!resp.ok) throw new Error(`GET /api/arcs ${resp.status}`)
      const json = (await resp.json()) as {
        arcs: ArcSummary[]
        more_issues_available?: boolean
      }
      return json.arcs
    },
    getKey: (item) => item.id,
    persistence,
    // GH#116 P1.3: bump from chains-collection's schemaVersion=1 because
    // the OPFS persistence is per-collection-id and the id changed
    // (`chains` → `arcs`); a fresh start is correct here. Belt-and-
    // suspenders against any client whose OPFS retained an old `arcs`
    // shard from an aborted earlier rollout.
    schemaVersion: 2,
  })
}

export const arcsCollection = createArcsCollection()

/**
 * @deprecated GH#116 P1.3 transitional alias — client code still
 * importing `chainsCollection` from `~/db/chains-collection` is
 * temporarily redirected to `arcsCollection`. The path also moved
 * (`chains-collection.ts` → `arcs-collection.ts`) so importers must
 * update their import path before this alias is dropped in P5. Do NOT
 * add new importers of this name; client sweep lands in P1.4.
 */
export const chainsCollection = arcsCollection
