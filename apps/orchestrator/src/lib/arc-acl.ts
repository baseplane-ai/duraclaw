/**
 * GH#152 P1 (B1) — per-arc ACL gate.
 *
 * Replaces the legacy session-level `checkSessionAccess` (which tested
 * `agent_sessions.visibility` + `userId === sessionRow.userId`) with an
 * arc-derived check. Membership lives in `arc_members`; visibility
 * lives on `arcs.visibility`. Sessions inherit access from their parent
 * arc — see `checkSessionAccessViaArc` in server.ts for the wrapper
 * that converts `sessionId → arcId → checkArcAccess`.
 *
 * Invariants:
 *  - Admins always pass (role: 'owner', for moderation parity).
 *  - Public arcs allow any authed user (role: null unless they happen
 *    to be in arc_members, in which case the membership role wins).
 *  - Private arcs require an `arc_members` row.
 *  - System actor — preserved from the legacy `checkSessionAccess`
 *    behaviour: when the arc's owning userId is the literal sentinel
 *    `'system'` (orphan / discovery-side row), we fall back to the
 *    public-arc treatment so tooling without a real user can still
 *    open the WS.
 */

import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { arcMembers, arcs } from '~/db/schema'
import type { Env } from '~/lib/types'

export interface ArcAccessUserSession {
  userId: string
  role: string
}

export type ArcAccessReason = 'arc_not_found' | 'forbidden' | 'unauthenticated'

export interface ArcAccessResult {
  allowed: boolean
  role: 'owner' | 'member' | null
  reason?: ArcAccessReason
}

/**
 * Test whether `userSession` may access arc `arcId`.
 *
 * The `env` parameter is reserved for forward compatibility (e.g. a
 * future SYSTEM_ACTOR_TOKEN env-driven escape hatch); current callers
 * pass it but the body only consults it through the legacy-actor
 * comparison below.
 */
export async function checkArcAccess(
  _env: Env,
  db: DrizzleD1Database<typeof schema>,
  arcId: string,
  userSession: ArcAccessUserSession | null,
): Promise<ArcAccessResult> {
  if (!userSession) {
    return { allowed: false, role: null, reason: 'unauthenticated' }
  }

  const arcRows = await db
    .select({
      id: arcs.id,
      userId: arcs.userId,
      visibility: arcs.visibility,
    })
    .from(arcs)
    .where(eq(arcs.id, arcId))
    .limit(1)
  const arc = arcRows[0]
  if (!arc) return { allowed: false, role: null, reason: 'arc_not_found' }

  // Admin override — moderation parity with the legacy session-level
  // checkSessionAccess.
  if (userSession.role === 'admin') {
    return { allowed: true, role: 'owner' }
  }

  // System-actor escape hatch (legacy parity): if the arc itself is owned
  // by the `'system'` sentinel (orphan / discovery-side row), behave as
  // if the arc were public. The legacy check used `sessionRow.userId ===
  // 'system'` here; we hoist the same heuristic to the arc level.
  if (arc.userId === 'system') {
    const memberRow = await db
      .select({ role: arcMembers.role })
      .from(arcMembers)
      .where(and(eq(arcMembers.arcId, arcId), eq(arcMembers.userId, userSession.userId)))
      .limit(1)
    return { allowed: true, role: memberRow[0]?.role ?? null }
  }

  const memberRows = await db
    .select({ role: arcMembers.role })
    .from(arcMembers)
    .where(and(eq(arcMembers.arcId, arcId), eq(arcMembers.userId, userSession.userId)))
    .limit(1)
  if (memberRows[0]) {
    return { allowed: true, role: memberRows[0].role }
  }

  if (arc.visibility === 'public') {
    return { allowed: true, role: null }
  }

  return { allowed: false, role: null, reason: 'forbidden' }
}
