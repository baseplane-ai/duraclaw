/**
 * Worktree reservation helper — GH#115 P1.4. Now `worktreeId`-keyed
 * (no longer `(issueNumber, worktree)`-keyed). Same-row re-entry is
 * idempotent and refreshes `lastTouchedAt`; cross-`reservedBy` calls
 * return 409 via the underlying bind helper.
 *
 * Used by:
 *   - `tryAutoAdvance` (~/lib/auto-advance) — successor inherits
 *     predecessor's worktreeId.
 *   - The thin-wrapped `/api/chains/:issue/checkout` endpoint, which
 *     now resolves `issueNumber` → `worktreeId` via agent_sessions
 *     before delegating here.
 */

import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { ReservedBy, WorktreeRow } from '~/api/worktrees-types'
import type * as schema from '~/db/schema'
import { bindWorktreeById } from '~/lib/reserve-worktree'

type DB = DrizzleD1Database<typeof schema>

export interface CheckoutWorktreeParams {
  worktreeId: string
  /** mode_at_checkout label, threaded for audit only. */
  mode: string
  reservedBy: ReservedBy
}

export type CheckoutWorktreeResult =
  | { ok: true; reservation: WorktreeRow }
  | { ok: false; status: 404; error: string }
  | { ok: false; status: 409; conflict: WorktreeRow; message: string }
  | { ok: false; status: 500; error: string }

export async function checkoutWorktree(
  db: DB,
  params: CheckoutWorktreeParams,
  userId: string,
): Promise<CheckoutWorktreeResult> {
  try {
    const result = await bindWorktreeById(db, params.worktreeId, params.reservedBy, userId)
    if (result.ok) return { ok: true, reservation: result.row }
    if (result.kind === 'not_found') {
      return { ok: false, status: 404, error: `worktreeId ${params.worktreeId} not found` }
    }
    return {
      ok: false,
      status: 409,
      conflict: result.existing,
      message: `Worktree held by ${result.existing.reservedBy?.kind ?? '?'}:${result.existing.reservedBy?.id ?? '?'}`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed'
    return { ok: false, status: 500, error: message }
  }
}
