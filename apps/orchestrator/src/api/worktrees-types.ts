/**
 * GH#115: shared request/response types for the worktrees API.
 * See planning/specs/115-worktrees-first-class-resource.md §B-API-*
 * and §B-CONCURRENCY-*.
 */

export type ReservedByKind = 'arc' | 'session' | 'manual'

export interface ReservedBy {
  kind: ReservedByKind
  // Numeric for `kind:'arc'` (kataIssue), string for everything else.
  id: string | number
}

/**
 * v1 only supports {kind:'fresh'}; pool-pick from the registry. Future
 * v2 may add {kind:'register'} for explicit clone registration; today
 * registration of pre-existing clones happens via the gateway sweep
 * (B-DISCOVERY-1), not via this user-facing API.
 */
export interface WorktreeReserveRequest {
  kind: 'fresh'
  reservedBy: ReservedBy
}

export interface WorktreeRow {
  id: string
  path: string
  branch: string | null
  status: 'free' | 'held' | 'active' | 'cleanup'
  reservedBy: ReservedBy | null
  ownerId: string
  releasedAt: number | null
  createdAt: number
  lastTouchedAt: number
}

/** B-CONCURRENCY-1: returned when an explicit-id reserve targets a row
 * whose reservedBy differs from caller's. */
export interface WorktreeConflictBody {
  error: 'conflict'
  existing: { reservedBy: ReservedBy | null; status: WorktreeRow['status']; path: string }
}

/** B-API-5 503: pool exhausted on `{kind:'fresh'}` request. */
export interface WorktreePoolExhaustedBody {
  error: 'pool_exhausted'
  freeCount: number
  totalCount: number
  hint: string
}

/** Body shape for the new `worktree` field on POST /api/sessions. */
export type SessionWorktreeParam = { kind: 'fresh' } | { id: string }
