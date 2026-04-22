import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { and, eq, isNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { userTabs } from '~/db/schema'
import type { Env, UserTabRow } from '~/lib/types'

/**
 * Broadcast the full current tab set for a user as a snapshot frame.
 *
 * Every tab mutation (insert, update, delete, reorder) calls this instead
 * of per-op `broadcastSyncedDelta`. The client diffs against its local
 * state — anything not in the snapshot is implicitly deleted. No lost-
 * delete risk, self-healing on every frame.
 */
export async function broadcastTabsSnapshot(
  env: Env,
  userId: string,
  db: DrizzleD1Database<typeof schema>,
): Promise<void> {
  if (!env.SYNC_BROADCAST_SECRET) {
    console.warn('[broadcast] SYNC_BROADCAST_SECRET not configured — skipping')
    return
  }

  const allTabs = (await db
    .select()
    .from(userTabs)
    .where(and(eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))) as UserTabRow[]

  const frame: SyncedCollectionFrame<UserTabRow> = {
    type: 'synced-collection-delta',
    collection: 'user_tabs',
    snapshot: true,
    ops: allTabs.map((tab) => ({ type: 'insert', value: tab })),
  }

  const stub = env.USER_SETTINGS.get(env.USER_SETTINGS.idFromName(userId))
  try {
    const resp = await stub.fetch('https://user-settings/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SYNC_BROADCAST_SECRET}`,
      },
      body: JSON.stringify(frame),
    })
    if (!resp.ok) {
      console.warn(`[broadcast] non-ok ${resp.status} for user=${userId} collection=user_tabs`)
    }
  } catch (err) {
    console.warn('[broadcast] fetch failed', err)
  }
}
