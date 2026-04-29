import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { buildArcRow } from '~/lib/arcs'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import type { Env } from '~/lib/types'

/**
 * GH#116: file renamed from `broadcast-chain.ts`. The single helper
 * is `broadcastArcRow` — keyed by `arcId`, calling `buildArcRow`,
 * fanning out to the owning user's UserSettingsDO.
 */

/**
 * Fire-and-forget broadcast of a single arc row to the owning user's
 * UserSettingsDO. Mirror of `broadcastSessionRow` for the `arcs` synced
 * collection.
 *
 * Arcs are user-scoped per the `idx_arcs_user_status_lastactivity` index
 * (and `buildArcRow` filters by `arcs.userId`), so fanout is single-user
 * — no presence-set walk required. The actor is always the arc owner;
 * other devices belonging to the same user receive the delta via the
 * UserSettingsDO's own socket fanout.
 *
 * `op` is `'update'` for arc rebuilds (the typical case) and `'delete'`
 * when `buildArcRow` returns null (arc was hard-deleted or scoped out).
 * The synced-collection sync path treats `update` on an unknown key as
 * an upsert, so brand-new arcs land correctly without a separate
 * `'insert'` op.
 */
export async function broadcastArcRow(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  userId: string,
  arcId: string,
): Promise<void> {
  if (!userId || !arcId) return

  const db = drizzle(env.AUTH_DB, { schema })

  // Resolve the row outside waitUntil so we can short-circuit when the
  // arc genuinely has nothing to report (e.g. unauthorised lookup or
  // deleted arc). Synchronous so the owner sees their own change without
  // a deferred-await delay.
  const row = await buildArcRow(env, db, userId, arcId)

  const op = row
    ? ({ type: 'update' as const, value: row } as const)
    : ({ type: 'delete' as const, key: arcId } as const)

  ctx.waitUntil(broadcastSyncedDelta(env, userId, 'arcs', [op]))
}
