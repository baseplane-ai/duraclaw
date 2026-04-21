/**
 * Branch Info Collection — per-session factory keyed on `parentMsgId`.
 *
 * GH#38 P1.5: migrated onto `createSyncedCollection` so the DO-pushed
 * `{type:'synced-collection-delta', collection:'branchInfo:<sessionId>'}`
 * frames drive begin/write/commit on the synced layer. No REST queryFn
 * — the DO is the sole writer and the onConnect replay re-emits every
 * row via `broadcastBranchInfo({targetClientId})` so cold loads converge
 * without an HTTP round-trip.
 *
 * Memoised per-sessionId so repeat calls return the same Collection
 * instance — required for `useLiveQuery` stability.
 */
import type { BranchInfoRow as SharedBranchInfoRow } from '@duraclaw/shared-types'
import {
  onSessionStreamReconnect,
  subscribeSessionStream,
} from '~/features/agent-orch/use-coding-agent'
import { dbReady } from './db-instance'
import { createSyncedCollection } from './synced-collection'

// Re-export with the existing local name so consumers keep their import
// paths unchanged. The shared-types shape is structurally identical.
export type BranchInfoRow = SharedBranchInfoRow

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BranchInfoCollection = any

const persistence = await dbReady

/** Memoise per-sessionId so useMemo(() => createBranchInfoCollection(id)) is stable. */
const collectionsBySession = new Map<string, BranchInfoCollection>()

/**
 * Get-or-create a branch-info collection for the given sessionId.
 * DO-push-only (no queryFn). Server re-emits full rows on reconnect via
 * the `onConnect` path; the factory's `onReconnect` hook invalidates the
 * queryKey so the synced layer accepts the next delta stream cleanly.
 */
export function createBranchInfoCollection(sessionId: string): BranchInfoCollection {
  const cached = collectionsBySession.get(sessionId)
  if (cached) return cached

  const collection = createSyncedCollection<BranchInfoRow, string>({
    id: `branch_info:${sessionId}`,
    collection: `branchInfo:${sessionId}`,
    queryKey: ['branchInfo', sessionId] as const,
    getKey: (row) => row.parentMsgId,
    subscribe: (handler) => subscribeSessionStream(sessionId, handler),
    onReconnect: (handler) => onSessionStreamReconnect(sessionId, handler),
    // No REST endpoint — the DO's onConnect replay re-emits every row via
    // `broadcastBranchInfo({targetClientId})`. Cold-start returns empty;
    // the targeted frame that follows populates the synced layer.
    queryFn: async () => [],
    persistence: persistence ?? null,
    // Bump from v1 → v2 so any OPFS rows cached under the prior wire
    // (pre-migration MessagesFrame snapshot upserts) are dropped on first
    // load after deploy.
    schemaVersion: 2,
  })

  collectionsBySession.set(sessionId, collection)
  return collection
}
