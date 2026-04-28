/**
 * GH#115 P1.2: shared reserve helper called by both `POST /api/worktrees`
 * and `POST /api/sessions { worktree: { kind: 'fresh' } }`.
 *
 * Mirrors the spec's "Atomic reserve" code pattern (§Implementation Hints).
 * Wraps lookup + allocate in a single Drizzle transaction so the race
 * window is minimal — D1 doesn't support `SELECT ... FOR UPDATE`, so the
 * eligibility query plus the targeted `UPDATE ... WHERE id = ?` is the
 * canonical D1-friendly pattern.
 *
 * See planning/specs/115-worktrees-first-class-resource.md §B-API-1,
 * §B-LIFECYCLE-3 / 4, §B-CONCURRENCY-1 / 2 / 3.
 */

import { and, eq, isNotNull, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { ReservedBy, WorktreeRow } from '~/api/worktrees-types'
import type * as schema from '~/db/schema'
import { worktrees } from '~/db/schema'

type DB = DrizzleD1Database<typeof schema>

export type ReserveResult =
  | { ok: true; row: WorktreeRow }
  | { ok: false; kind: 'pool_exhausted'; freeCount: number; totalCount: number }

export type BindResult =
  | { ok: true; row: WorktreeRow }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'conflict'; existing: WorktreeRow }

type WorktreeRowSelect = typeof worktrees.$inferSelect

/**
 * Convert a Drizzle row from `worktrees` into the WorktreeRow API shape
 * (parses reservedBy JSON, normalizes status type). Use this in every
 * handler that returns rows.
 */
export function rowToDto(r: WorktreeRowSelect): WorktreeRow {
  let parsed: ReservedBy | null = null
  if (r.reservedBy) {
    try {
      const obj = JSON.parse(r.reservedBy) as { kind?: string; id?: unknown }
      if (
        obj &&
        typeof obj.kind === 'string' &&
        (obj.kind === 'arc' || obj.kind === 'session' || obj.kind === 'manual') &&
        (typeof obj.id === 'string' || typeof obj.id === 'number')
      ) {
        parsed = { kind: obj.kind, id: obj.id }
      }
    } catch {
      // Malformed JSON — leave null so callers see "no reservation" rather
      // than crashing the handler. The sweep / admin DELETE can clean up.
    }
  }
  // Status enum coercion — schema stores TEXT with a CHECK constraint.
  const status = r.status as WorktreeRow['status']
  return {
    id: r.id,
    path: r.path,
    branch: r.branch ?? null,
    status,
    reservedBy: parsed,
    ownerId: r.ownerId,
    releasedAt: r.releasedAt ?? null,
    createdAt: r.createdAt,
    lastTouchedAt: r.lastTouchedAt,
  }
}

function reservedByMatches(parsed: ReservedBy | null, want: ReservedBy): boolean {
  if (!parsed) return false
  // ID compare is permissive across string/number — the JSON column may
  // round-trip a number-id as either, depending on writer. Compare by
  // string form for stability.
  return parsed.kind === want.kind && String(parsed.id) === String(want.id)
}

/**
 * Reserve a fresh clone from the registry. Same-`reservedBy` re-acquire
 * is idempotent (B-CONCURRENCY-3). Eligibility ordering: free rows
 * first (lowest lastTouchedAt), cleanup-released rows as fallback
 * (B-LIFECYCLE-4). Returns a typed pool_exhausted result on empty pool
 * (caller maps to 503).
 */
export async function reserveFreshWorktree(
  db: DB,
  reservedBy: ReservedBy,
  ownerId: string,
): Promise<ReserveResult> {
  const result = await db.transaction(async (tx) => {
    // 1. Same-reservedBy idempotency (B-CONCURRENCY-3). Match regardless
    //    of status — chain auto-advance retries hit this branch.
    const existing = await tx
      .select()
      .from(worktrees)
      .where(
        and(
          sql`json_extract(${worktrees.reservedBy}, '$.kind') = ${reservedBy.kind}`,
          sql`json_extract(${worktrees.reservedBy}, '$.id') = ${reservedBy.id}`,
        ),
      )
      .limit(1)
    if (existing[0]) {
      const row = existing[0]
      // B-LIFECYCLE-3: re-attach during grace window clears released_at.
      if (row.releasedAt != null) {
        const now = Date.now()
        const updated = await tx
          .update(worktrees)
          .set({ releasedAt: null, status: 'held', lastTouchedAt: now })
          .where(eq(worktrees.id, row.id))
          .returning()
        return { ok: true as const, row: rowToDto(updated[0]) }
      }
      return { ok: true as const, row: rowToDto(row) }
    }

    // 2. Allocate from eligible pool. Free rows first (no implicit owner),
    //    cleanup-released rows as fallback (B-LIFECYCLE-4). Order by
    //    lastTouchedAt asc within each tier.
    const eligible = await tx
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(
        or(
          eq(worktrees.status, 'free'),
          and(eq(worktrees.status, 'cleanup'), isNotNull(worktrees.releasedAt)),
        ),
      )
      .orderBy(sql`case ${worktrees.status} when 'free' then 0 else 1 end`, worktrees.lastTouchedAt)
      .limit(1)

    if (eligible.length === 0) {
      // Pool exhausted — collect counts for the 503 body.
      const counts = await tx
        .select({
          free: sql<number>`sum(case when ${worktrees.status} = 'free' then 1 else 0 end)`,
          total: sql<number>`count(*)`,
        })
        .from(worktrees)
      return {
        ok: false as const,
        kind: 'pool_exhausted' as const,
        freeCount: Number(counts[0]?.free ?? 0),
        totalCount: Number(counts[0]?.total ?? 0),
      }
    }

    const now = Date.now()
    const allocated = await tx
      .update(worktrees)
      .set({
        status: 'held',
        reservedBy: JSON.stringify(reservedBy),
        releasedAt: null,
        lastTouchedAt: now,
        ownerId,
      })
      .where(eq(worktrees.id, eligible[0].id))
      .returning()
    return { ok: true as const, row: rowToDto(allocated[0]) }
  })

  return result
}

/**
 * Bind a session to an explicit-id worktree. Validates that the row's
 * existing reservedBy matches (or the row is fresh-eligible per
 * B-LIFECYCLE-4); else returns a conflict result.
 *
 * B-CONCURRENCY-2 sharing policy is enforced via the conflict path:
 * same-kind + same-id is idempotent re-acquire; different-id is a
 * conflict. Kata-side callers are responsible for not requesting an
 * explicit-id bind for `kind:'arc'` after they've already obtained a
 * row via fresh-pick.
 */
export async function bindWorktreeById(
  db: DB,
  worktreeId: string,
  reservedBy: ReservedBy,
  ownerId: string,
): Promise<BindResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(worktrees).where(eq(worktrees.id, worktreeId)).limit(1)
    if (rows.length === 0) {
      return { ok: false as const, kind: 'not_found' as const }
    }
    const row = rows[0]
    const parsed = rowToDto(row).reservedBy

    // Same-reservedBy idempotent re-acquire (B-CONCURRENCY-3).
    if (reservedByMatches(parsed, reservedBy)) {
      const now = Date.now()
      const updated = await tx
        .update(worktrees)
        .set(
          row.releasedAt != null
            ? { releasedAt: null, status: 'held', lastTouchedAt: now }
            : { lastTouchedAt: now },
        )
        .where(eq(worktrees.id, row.id))
        .returning()
      return { ok: true as const, row: rowToDto(updated[0]) }
    }

    // B-LIFECYCLE-4: fresh-eligible released row (different reservedBy)
    // is treated as free for allocation. Also covers status='free' rows
    // that happen to have a stale reservedBy (shouldn't occur, but defends).
    const freshEligible =
      row.status === 'free' || (row.status === 'cleanup' && row.releasedAt != null)
    if (freshEligible) {
      const now = Date.now()
      const updated = await tx
        .update(worktrees)
        .set({
          status: 'held',
          reservedBy: JSON.stringify(reservedBy),
          releasedAt: null,
          lastTouchedAt: now,
          ownerId,
        })
        .where(eq(worktrees.id, row.id))
        .returning()
      return { ok: true as const, row: rowToDto(updated[0]) }
    }

    // B-CONCURRENCY-1: cross-reservation conflict.
    return {
      ok: false as const,
      kind: 'conflict' as const,
      existing: rowToDto(row),
    }
  })
}
