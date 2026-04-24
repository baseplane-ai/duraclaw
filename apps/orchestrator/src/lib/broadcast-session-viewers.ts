/**
 * session_viewers cross-user fanout.
 *
 * The `session_viewers` synced collection answers "who else has this
 * session open as a tab?" — a durable, tab-level view of presence that
 * complements the ephemeral y-partyserver awareness used for the in-chat
 * typing / cursor overlay. Source of truth is `user_tabs`: the list of
 * current viewers for a session is every live (non-deleted) `user_tabs`
 * row pointing at that sessionId.
 *
 * Called from the `user_tabs` mutation handlers (POST/PATCH/DELETE) with
 * the set of sessionIds whose viewer list may have changed. For each
 * affected session we recompute the full viewer set, then broadcast each
 * viewer their personalised row (self excluded) via
 * `broadcastSyncedDelta`. When `removedForUserId` is set, any affected
 * session where that user is no longer in the viewer set also gets a
 * `delete` op to prune the stale row from their collection.
 *
 * Fanout is best-effort (`Promise.allSettled`) and wrapped in
 * `ctx.waitUntil` at the call site so response latency is unaffected.
 * Dropped frames are self-healing: the client's reconnect invalidates
 * the query and re-fetches via `getSessionViewersForUser`.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { users, userTabs } from '~/db/schema'
import { broadcastSyncedDelta } from './broadcast-synced-delta'
import type { Env, SessionViewer, SessionViewerRow } from './types'

type Db = DrizzleD1Database<typeof schema>

/**
 * Recompute viewer lists for `sessionIds` and broadcast the resulting
 * `session_viewers` row to every user who currently has any of those
 * sessions as a live tab. Each recipient gets a row with themselves
 * filtered out of `viewers`.
 *
 * If `removedForUserId` is provided (tab delete / sessionId change), any
 * affected session where that user is no longer a viewer also gets a
 * `delete` op so their collection doesn't keep a stale row.
 */
export async function fanoutSessionViewerChange(
  env: Env,
  db: Db,
  sessionIds: string[],
  removedForUserId?: string,
): Promise<void> {
  if (sessionIds.length === 0) return

  const tabRows = await db
    .select({
      sessionId: userTabs.sessionId,
      userId: userTabs.userId,
      name: users.name,
    })
    .from(userTabs)
    .innerJoin(users, eq(users.id, userTabs.userId))
    .where(and(inArray(userTabs.sessionId, sessionIds), isNull(userTabs.deletedAt)))

  const bySession = new Map<string, SessionViewer[]>()
  for (const row of tabRows) {
    if (!row.sessionId) continue
    const entry = bySession.get(row.sessionId)
    const viewer: SessionViewer = { userId: row.userId, name: row.name }
    if (entry) entry.push(viewer)
    else bySession.set(row.sessionId, [viewer])
  }

  const broadcasts: Promise<unknown>[] = []
  for (const sessionId of sessionIds) {
    const viewers = bySession.get(sessionId) ?? []
    for (const v of viewers) {
      const othersForThisUser = viewers.filter((x) => x.userId !== v.userId)
      const row: SessionViewerRow = { sessionId, viewers: othersForThisUser }
      broadcasts.push(
        broadcastSyncedDelta(env, v.userId, 'session_viewers', [{ type: 'update', value: row }]),
      )
    }
    if (removedForUserId && !viewers.some((v) => v.userId === removedForUserId)) {
      broadcasts.push(
        broadcastSyncedDelta(env, removedForUserId, 'session_viewers', [
          { type: 'delete', key: sessionId },
        ]),
      )
    }
  }

  await Promise.allSettled(broadcasts)
}

/**
 * Build the current `session_viewers` rows for `userId` — one row per
 * session they have as a live tab, with the OTHER viewers populated. Used
 * by the synced collection's `queryFn` for cold start and reconnect
 * resync.
 */
export async function getSessionViewersForUser(
  db: Db,
  userId: string,
): Promise<SessionViewerRow[]> {
  const mySessionRows = await db
    .select({ sessionId: userTabs.sessionId })
    .from(userTabs)
    .where(and(eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))

  const mySessionIds = Array.from(
    new Set(mySessionRows.map((r) => r.sessionId).filter((s): s is string => !!s)),
  )
  if (mySessionIds.length === 0) return []

  const rows = await db
    .select({
      sessionId: userTabs.sessionId,
      userId: userTabs.userId,
      name: users.name,
    })
    .from(userTabs)
    .innerJoin(users, eq(users.id, userTabs.userId))
    .where(and(inArray(userTabs.sessionId, mySessionIds), isNull(userTabs.deletedAt)))

  const bySession = new Map<string, SessionViewer[]>()
  for (const row of rows) {
    if (!row.sessionId) continue
    const entry = bySession.get(row.sessionId)
    const viewer: SessionViewer = { userId: row.userId, name: row.name }
    if (entry) entry.push(viewer)
    else bySession.set(row.sessionId, [viewer])
  }

  return mySessionIds.map((sessionId) => ({
    sessionId,
    viewers: (bySession.get(sessionId) ?? []).filter((v) => v.userId !== userId),
  }))
}
