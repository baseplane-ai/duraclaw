import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { userPresence } from '~/db/schema'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { buildChainRow } from '~/lib/chains'
import type { Env } from '~/lib/types'

/**
 * Fire-and-forget broadcast of a single chain row to every online user.
 *
 * Mirror of `broadcastSessionRow` for the `chains` synced collection. The
 * `/api/chains` read path is global today (no `user_id` filter — every
 * authenticated user sees every chain), so deltas fan out to the union of
 * `user_presence` plus the optional `actorUserId` (so the actor sees the
 * change immediately even if their presence row hasn't been written yet,
 * matching the public-session fanout pattern in `broadcast-session.ts`).
 *
 * `op` is `'update'` for chain rebuilds (the typical case) and `'delete'`
 * when `buildChainRow` returns null because the chain has no remaining
 * sessions and no GH metadata. The synced-collection sync path treats
 * `update` on an unknown key as an upsert, so brand-new chains land
 * correctly without a separate `'insert'` op.
 *
 * Why this exists: previously `chains` deltas only fired from the
 * SessionDO via `syncKataToD1` → `broadcastChainUpdate`, so the board
 * silently went stale on every UI-driven mutation that changed the chain
 * shape (advance / checkout / release). The kanban consumes
 * `chainsCollection` via `useLiveQuery`; without these broadcasts the
 * board only refreshed on cold load or window-focus refetch.
 */
export async function broadcastChainRow(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  issueNumber: number,
  options?: { actorUserId?: string },
): Promise<void> {
  if (!Number.isFinite(issueNumber)) return

  const db = drizzle(env.AUTH_DB, { schema })

  // Resolve the row outside waitUntil so we can short-circuit when the
  // chain genuinely has nothing to report. The actor-user lookup also
  // runs synchronously so they see their own change without waiting on
  // the presence index.
  const row = await buildChainRow(env, db, options?.actorUserId ?? '', issueNumber)

  const presenceRows = await db.select({ userId: userPresence.userId }).from(userPresence)
  const targets = new Set<string>()
  for (const r of presenceRows) targets.add(r.userId)
  if (options?.actorUserId) targets.add(options.actorUserId)
  if (targets.size === 0) return

  // Same fanout cap as `broadcastSessionRow` so a presence index that
  // grows unbounded can't tip a single broadcast into worker-CPU jail.
  const PUBLIC_FANOUT_CAP = 100
  const targetList = Array.from(targets)
  if (targetList.length > PUBLIC_FANOUT_CAP) {
    console.warn(
      `[broadcastChainRow] fanout cap hit: issue=${issueNumber} online=${targetList.length} cap=${PUBLIC_FANOUT_CAP} — truncating`,
    )
    targetList.length = PUBLIC_FANOUT_CAP
  }

  const op = row
    ? ({ type: 'update' as const, value: row } as const)
    : ({ type: 'delete' as const, key: String(issueNumber) } as const)

  ctx.waitUntil(
    Promise.allSettled(targetList.map((uid) => broadcastSyncedDelta(env, uid, 'chains', [op]))),
  )
}
