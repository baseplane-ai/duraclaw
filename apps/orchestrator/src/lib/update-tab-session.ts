/**
 * Tab session rebind helper — used by the server-side auto-advance path
 * (`maybeAutoAdvanceChain` in SessionDO) to retarget every non-deleted
 * user_tab row that points at a completed session to its just-spawned
 * successor. Broadcasts a synced-collection delta per updated row so all
 * connected clients converge within the usual WS round-trip.
 *
 * The REST `PATCH /api/user-settings/tabs/:id` handler continues to serve
 * the generic "user renamed / repositioned / rebound this tab" path — it
 * is intentionally a separate code path and not migrated onto this helper.
 */

import { and, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { userTabs } from '~/db/schema'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import type { Env, UserTabRow } from '~/lib/types'

/**
 * Rebind every non-deleted tab for `userId` that currently points at
 * `oldSessionId` over to `newSessionId`. Returns the number of rows
 * updated. Broadcasts are fire-and-forget; when `executionCtx` is
 * provided the fanout is wrapped in `waitUntil`, otherwise it's awaited
 * inline (so callers with no waitUntil still see the broadcast settle).
 */
export async function rebindTabsForSession(
  env: Env,
  userId: string,
  oldSessionId: string,
  newSessionId: string,
  executionCtx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<number> {
  const db = drizzle(env.AUTH_DB, { schema })

  const updated = await db
    .update(userTabs)
    .set({ sessionId: newSessionId })
    .where(
      and(
        eq(userTabs.userId, userId),
        eq(userTabs.sessionId, oldSessionId),
        isNull(userTabs.deletedAt),
      ),
    )
    .returning()

  for (const row of updated) {
    const typed = row as UserTabRow
    const p = broadcastSyncedDelta(env, userId, 'user_tabs', [{ type: 'update', value: typed }])
    if (executionCtx) {
      executionCtx.waitUntil(p)
    } else {
      // Await inline so the DO's caller sees the fanout settle (or fail)
      // before returning from the auto-advance handler.
      await p.catch((err) => console.warn('[rebindTabsForSession] broadcast failed', err))
    }
  }

  return updated.length
}
