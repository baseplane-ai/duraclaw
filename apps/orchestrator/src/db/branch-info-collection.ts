/**
 * Branch Info Collection — per-session factory keyed on `parentMsgId`.
 *
 * Sourced exclusively from DO-authored snapshot payloads (GH#14 B7). The DO
 * pushes the `branchInfo?: BranchInfoRow[]` field on snapshot payloads (see
 * `SnapshotPayload` in shared-types); the client upserts each row into this
 * collection. No REST queryFn — `localOnlyCollectionOptions` because the DO
 * is the only writer. OPFS-persisted so tab-switch renders branch arrows
 * instantly.
 *
 * The factory memoises per-agentName so repeat calls return the same
 * Collection instance — required for `useLiveQuery` stability.
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import { dbReady } from './db-instance'

export interface BranchInfoRow {
  /** The parent user-message id — primary key. */
  parentMsgId: string
  sessionId: string
  /** Sibling user-message ids in creation order. */
  siblings: string[]
  /** Whichever sibling is currently on the active branch. */
  activeId: string
  updatedAt: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BranchInfoCollection = any

const persistence = await dbReady

/** Memoise per-agentName so useMemo(() => createBranchInfoCollection(id)) is stable. */
const collectionsByAgent = new Map<string, BranchInfoCollection>()

/**
 * Get-or-create a branch-info collection for the given agentName.
 * DO-push-only (no queryFn). See B7 in planning/specs/14.
 */
export function createBranchInfoCollection(agentName: string): BranchInfoCollection {
  const cached = collectionsByAgent.get(agentName)
  if (cached) return cached

  const localOpts = localOnlyCollectionOptions<BranchInfoRow, string>({
    id: `branch_info:${agentName}`,
    getKey: (row: BranchInfoRow) => row.parentMsgId,
  })

  let collection: BranchInfoCollection
  if (persistence) {
    const opts = persistedCollectionOptions({
      ...localOpts,
      persistence,
      schemaVersion: 1,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collection = createCollection(opts as any)
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collection = createCollection(localOpts as any)
  }

  collectionsByAgent.set(agentName, collection)
  return collection
}
