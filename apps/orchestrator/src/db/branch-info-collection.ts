/**
 * Branch Info Collection — per-session factory keyed on `parentMsgId`.
 *
 * GH#47 sibling refactor: migrated onto the SyncConfig-direct pattern
 * (same as `messages-collection.ts`). The factory returns a raw
 * `CollectionConfig` whose `sync.sync` subscribes to the per-session WS
 * stream and applies `{collection: 'branchInfo:<sessionId>'}` delta
 * frames via `begin/write/commit`. No REST `queryFn` — the SessionDO is
 * the sole writer and its onConnect replay re-emits every row via
 * `broadcastBranchInfo({targetClientId})` so cold loads converge without
 * an HTTP round-trip.
 *
 * - `markReady()` fires eagerly at sync-start so consumers aren't gated
 *   on WS state. Empty-session connections are ready immediately.
 * - Reconnect: DO's onConnect re-emits the full row set; TanStack DB's
 *   insert→update auto-conversion absorbs the overlap.
 * - No `onInsert` / `onUpdate` / `onDelete` handlers — branchInfo is
 *   server-authoritative; clients don't mutate it locally.
 *
 * Memoised per-sessionId so repeat calls return the same Collection
 * instance — required for `useLiveQuery` stability.
 */
import type {
  BranchInfoRow as SharedBranchInfoRow,
  SyncedCollectionFrame,
} from '@duraclaw/shared-types'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import type { CollectionConfig, SyncConfig } from '@tanstack/db'
import { createCollection } from '@tanstack/db'
import {
  onSessionStreamReconnect,
  subscribeSessionStream,
} from '~/features/agent-orch/use-coding-agent'
import { dbReady } from './db-instance'

// Re-export with the existing local name so consumers keep their import
// paths unchanged. The shared-types shape is structurally identical.
export type BranchInfoRow = SharedBranchInfoRow

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BranchInfoCollection = any

const persistence = await dbReady

/** Memoise per-sessionId so useMemo(() => createBranchInfoCollection(id)) is stable. */
const collectionsBySession = new Map<string, BranchInfoCollection>()

/**
 * Build the raw `CollectionConfig` for a branchInfo collection keyed on
 * `sessionId`. Exposed as a separate fn for testing — the factory below
 * composes this with `persistedCollectionOptions` + `createCollection`.
 */
export function branchInfoCollectionOptions(sessionId: string): CollectionConfig<BranchInfoRow> {
  const collectionName = `branchInfo:${sessionId}`

  const sync: SyncConfig<BranchInfoRow>['sync'] = (params) => {
    const { begin, write, commit, markReady, collection } = params

    const unsubFrame = subscribeSessionStream(
      sessionId,
      (frame: SyncedCollectionFrame<unknown>) => {
        if (frame.collection !== collectionName) return
        begin()
        for (const op of frame.ops) {
          if (op.type === 'delete') {
            // `value` required at the type level; runtime ignores on delete.
            write({ type: 'delete', key: op.key, value: undefined as never })
            continue
          }
          // Insert→update auto-conversion (see messages-collection.ts for
          // the full reasoning). DO onConnect replays re-emit the same
          // rows with possibly-different values; converting to `update`
          // when the key is already present keeps writes idempotent.
          const row = op.value as BranchInfoRow
          const hasFn = collection?.has as ((key: string) => boolean) | undefined
          const alreadyPresent =
            op.type === 'insert' &&
            typeof hasFn === 'function' &&
            hasFn.call(collection, row.parentMsgId)
          write({ type: alreadyPresent ? 'update' : op.type, value: row })
        }
        commit()
      },
    )

    // Reconnect is a no-op — DO's onConnect replays every branchInfo row
    // via broadcastBranchInfo({targetClientId}).
    const unsubReconnect = onSessionStreamReconnect(sessionId, () => {})

    // No initial snapshot to wait for; the WS onConnect burst (if any)
    // arrives shortly after. Mark ready eagerly so consumers don't hang
    // on a frame that never arrives for sessions with no branches.
    markReady()

    return () => {
      unsubFrame()
      unsubReconnect()
    }
  }

  return {
    id: `branch_info:${sessionId}`,
    getKey: (row) => row.parentMsgId,
    sync: { sync },
  }
}

/**
 * Get-or-create a branch-info collection for the given sessionId.
 * DO-push-only (no queryFn). Server re-emits full rows on reconnect via
 * the onConnect path; cold load is served from the OPFS persisted cache
 * until the first frame arrives.
 */
export function createBranchInfoCollection(sessionId: string): BranchInfoCollection {
  const cached = collectionsBySession.get(sessionId)
  if (cached) return cached

  const options = branchInfoCollectionOptions(sessionId)
  const wrapped = persistence
    ? persistedCollectionOptions({
        ...options,
        persistence,
        // Bump from v2 → v3 so any OPFS rows cached under the prior
        // createSyncedCollection wrap are dropped on first load after deploy.
        schemaVersion: 3,
      })
    : options

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collection = createCollection(wrapped as any)
  collectionsBySession.set(sessionId, collection)
  return collection
}
