import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { userPresence } from '~/db/schema'
import { buildArcRow } from '~/lib/arcs'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { buildChainRow } from '~/lib/chains'
import type { Env } from '~/lib/types'

/**
 * GH#116 P1.3: file renamed from `broadcast-chain.ts`. The new primary
 * helper is `broadcastArcRow` (keyed by `arcId`, calling `buildArcRow`,
 * fanning out to the owning user). The legacy `broadcastChainRow` —
 * keyed by GitHub issue number, calling `buildChainRow`, fanning out to
 * every online user via the global presence index — is preserved here
 * as a transitional shim so the (about-to-be-deleted) `/api/chains/...`
 * route handlers and `lib/create-session.ts`'s `kataIssue` path keep
 * compiling until P3 deletes them outright. Do NOT add new callers of
 * `broadcastChainRow`.
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
  // deleted arc). Synchronous for the same reason
  // `broadcastChainRow` did it: the owner sees their own change without
  // a deferred-await delay.
  const row = await buildArcRow(env, db, userId, arcId)

  const op = row
    ? ({ type: 'update' as const, value: row } as const)
    : ({ type: 'delete' as const, key: arcId } as const)

  ctx.waitUntil(broadcastSyncedDelta(env, userId, 'arcs', [op]))
}

/**
 * @deprecated GH#116 P1.3 transitional shim. The chain routes
 * (`/api/chains/...`) and the `kataIssue` path in `create-session.ts`
 * still call this; P3 deletes the routes and P5 removes the kataIssue
 * compatibility, after which this function is unreachable and will be
 * deleted. New code MUST use `broadcastArcRow` (keyed by arcId).
 *
 * Preserves the original semantics verbatim: rebuilds the legacy
 * `ChainSummary` via `buildChainRow` and fans out to every user in
 * `user_presence` (chains are globally visible per the legacy
 * `/api/chains` read path).
 */
export async function broadcastChainRow(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  issueNumber: number,
  options?: { actorUserId?: string },
): Promise<void> {
  if (!Number.isFinite(issueNumber)) return

  const db = drizzle(env.AUTH_DB, { schema })

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
