import type { SyncedCollectionOp } from '@duraclaw/shared-types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { arcMembers } from '~/db/schema'
import type { Env } from '~/lib/types'
import { broadcastSyncedDelta } from './broadcast-synced-delta'

/**
 * GH#152 P1.3 WU-C: member-aware fanout helper.
 *
 * Unlike `broadcastSyncedDelta` (which targets a single user) and
 * `broadcastArcRow` (which broadcasts an arc summary update to the
 * arc's owner), this fans `ops` out to every user in `arc_members(arcId)`
 * via their per-user UserSettingsDO socket. Used by every arc-scoped
 * collab write (chat first; comments / reactions / awareness later).
 *
 * Member-list cache: an in-process `Map` with a 60s TTL. The chat
 * write path is hot, and a `SELECT user_id FROM arc_members WHERE
 * arc_id = ?` against D1 on every write would dominate latency. KV
 * was rejected (per spec line 856-859) — a 60s stale member list is
 * acceptable; a 200ms KV round-trip on every write is not.
 *
 * Cache invalidation: `arc-members.ts` calls `purgeArcMemberCache(arcId)`
 * synchronously after every membership INSERT / DELETE, so the next
 * write reads fresh members. Worker isolate eviction also clears the
 * cache implicitly — lossy but bounded.
 */

interface MemberCacheEntry {
  members: string[]
  expiresAt: number
}

const MEMBER_CACHE_TTL_MS = 60_000

const MEMBER_CACHE = new Map<string, MemberCacheEntry>()

/**
 * Synchronously clear the cached member list for `arcId`. Called from
 * `arc-members.ts` after INSERT / DELETE so the next chat broadcast
 * re-queries D1. Synchronous (NOT `waitUntil`) per spec line 879 —
 * the next write must observe the fresh set.
 */
export function purgeArcMemberCache(arcId: string): void {
  MEMBER_CACHE.delete(arcId)
}

async function loadMembers(env: Env, arcId: string): Promise<string[]> {
  const db = drizzle(env.AUTH_DB, { schema })
  const rows = await db
    .select({ userId: arcMembers.userId })
    .from(arcMembers)
    .where(eq(arcMembers.arcId, arcId))
  return rows.map((r) => r.userId)
}

interface BroadcastCtx {
  waitUntil: (p: Promise<unknown>) => void
}

/**
 * Fan an op-set out to every member of `arcId` over the per-user
 * synced-collection wire. The fanout itself runs under `ctx.waitUntil`
 * so the originating request response is not blocked on per-user
 * UserSettingsDO RPC latency — same pattern as `broadcastArcUpdate`.
 *
 * Failures are swallowed inside `broadcastSyncedDelta`; one bad user
 * stub does not abort the rest.
 */
export async function broadcastArcRoom<TRow>(
  env: Env,
  ctx: BroadcastCtx,
  arcId: string,
  channel: string,
  ops: SyncedCollectionOp<TRow>[],
): Promise<void> {
  if (ops.length === 0) return

  const now = Date.now()
  const cached = MEMBER_CACHE.get(arcId)
  let members: string[]
  if (cached && cached.expiresAt > now) {
    members = cached.members
  } else {
    try {
      members = await loadMembers(env, arcId)
    } catch (err) {
      console.warn(`[broadcast-arc-room] loadMembers failed arc=${arcId}:`, err)
      return
    }
    MEMBER_CACHE.set(arcId, {
      members,
      expiresAt: now + MEMBER_CACHE_TTL_MS,
    })
  }

  if (members.length === 0) return

  ctx.waitUntil(
    Promise.all(members.map((uid) => broadcastSyncedDelta(env, uid, channel, ops))).then(
      () => undefined,
    ),
  )
}
