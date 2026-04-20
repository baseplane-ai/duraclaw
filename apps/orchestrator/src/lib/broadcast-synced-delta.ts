import type { SyncedCollectionFrame, SyncedCollectionOp } from '@duraclaw/shared-types'
import type { Env } from '~/lib/types'

/**
 * Fire-and-forget broadcast of a synced-collection delta frame to the
 * target user's UserSettingsDO. Caller wraps with ctx.waitUntil so the
 * browser's original POST response is not blocked on the fanout.
 *
 * On failure (DO unreachable, 5xx, network): logs but does not retry.
 * The next client reconnect triggers a full-fetch resync via the
 * factory's queryFn, which closes the window. See GH#32 spec B7.
 */
export async function broadcastSyncedDelta<TRow>(
  env: Env,
  userId: string,
  collection: string,
  ops: Array<SyncedCollectionOp<TRow>>,
): Promise<void> {
  if (!env.SYNC_BROADCAST_SECRET) {
    console.warn('[broadcast] SYNC_BROADCAST_SECRET not configured — skipping')
    return
  }
  const frame: SyncedCollectionFrame<TRow> = {
    type: 'synced-collection-delta',
    collection,
    ops,
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
      console.warn(`[broadcast] non-ok ${resp.status} for user=${userId} collection=${collection}`)
    }
  } catch (err) {
    console.warn('[broadcast] fetch failed', err)
  }
}
