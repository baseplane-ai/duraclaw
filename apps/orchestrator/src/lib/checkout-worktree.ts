/**
 * Worktree reservation helper — extracted from `POST /api/chains/:issue/checkout`
 * so both the REST handler and the server-side auto-advance path
 * (`tryAutoAdvance` in ~/lib/auto-advance) can call the same logic without
 * a same-worker HTTP round-trip.
 */

import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { worktreeReservations } from '~/db/schema'
import type { WorktreeReservation } from '~/lib/types'

type DB = DrizzleD1Database<typeof schema>

export function reservationToDto(r: typeof worktreeReservations.$inferSelect): WorktreeReservation {
  return {
    issueNumber: r.issueNumber,
    worktree: r.worktree,
    ownerId: r.ownerId,
    heldSince: r.heldSince,
    lastActivityAt: r.lastActivityAt,
    modeAtCheckout: r.modeAtCheckout,
    stale: !!r.stale,
  }
}

export interface CheckoutWorktreeParams {
  issueNumber: number
  worktree: string
  modeAtCheckout: string
}

export type CheckoutWorktreeResult =
  | { ok: true; reservation: WorktreeReservation }
  | { ok: false; status: 409; conflict: WorktreeReservation; message: string }
  | { ok: false; status: 500; error: string }

/**
 * Atomically reserve a worktree for a chain. Same-chain re-entry is
 * idempotent and refreshes `lastActivityAt`; conflicts surface as a 409
 * with the winning reservation.
 */
export async function checkoutWorktree(
  db: DB,
  params: CheckoutWorktreeParams,
  userId: string,
): Promise<CheckoutWorktreeResult> {
  const { issueNumber, worktree, modeAtCheckout } = params
  const now = new Date().toISOString()

  const existingRows = await db
    .select()
    .from(worktreeReservations)
    .where(eq(worktreeReservations.worktree, worktree))
    .limit(1)
  const existing = existingRows[0]

  if (existing) {
    if (existing.issueNumber === issueNumber) {
      // Same-chain re-entry — idempotent refresh.
      const refreshed = await db
        .update(worktreeReservations)
        .set({ lastActivityAt: now, stale: false })
        .where(eq(worktreeReservations.worktree, worktree))
        .returning()
      const row = refreshed[0] ?? { ...existing, lastActivityAt: now, stale: false }
      return { ok: true, reservation: reservationToDto(row) }
    }
    return {
      ok: false,
      status: 409,
      conflict: reservationToDto(existing),
      message: `Worktree held by chain #${existing.issueNumber}`,
    }
  }

  try {
    const inserted = await db
      .insert(worktreeReservations)
      .values({
        worktree,
        issueNumber,
        ownerId: userId,
        heldSince: now,
        lastActivityAt: now,
        modeAtCheckout,
        stale: false,
      })
      .returning()
    return { ok: true, reservation: reservationToDto(inserted[0]) }
  } catch (err) {
    // UNIQUE constraint race — re-read and return 409 with winner.
    const raceRows = await db
      .select()
      .from(worktreeReservations)
      .where(and(eq(worktreeReservations.worktree, worktree)))
      .limit(1)
    const winner = raceRows[0]
    if (winner && winner.issueNumber === issueNumber) {
      return { ok: true, reservation: reservationToDto(winner) }
    }
    if (winner) {
      return {
        ok: false,
        status: 409,
        conflict: reservationToDto(winner),
        message: `Worktree held by chain #${winner.issueNumber}`,
      }
    }
    const message = err instanceof Error ? err.message : 'Checkout failed'
    return { ok: false, status: 500, error: message }
  }
}
