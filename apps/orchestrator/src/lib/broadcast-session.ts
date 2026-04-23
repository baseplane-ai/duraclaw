import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions, userPresence } from '~/db/schema'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import type { Env } from '~/lib/types'

/**
 * Fire-and-forget broadcast of a single `agent_sessions` row to the set of
 * users that should see it. Spec #37 B2, widened by spec #68 B7 to fan out
 * public sessions to every online user (so shared/public sessions show up
 * in peers' session lists in real time).
 *
 * - SELECTs the full row by id; returns if row is gone (cascade-delete race).
 * - Skips broadcast if `userId === 'system'` (orphan-session suppression).
 * - `visibility === 'public'`: queries `user_presence` for the set of
 *   currently-online users and fans out via `Promise.allSettled` so one
 *   dead DO doesn't abort the rest.
 * - `visibility === 'private'` (or missing): single-owner path.
 * - Wraps the fanout call in `ctx.waitUntil` so the caller doesn't block.
 * - Errors are swallowed inside waitUntil; client self-heals via queryFn
 *   refetch on WS reconnect (see spec #37 B2 error-handling note).
 */
export async function broadcastSessionRow(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  sessionId: string,
  op: 'insert' | 'update',
): Promise<void> {
  const db = drizzle(env.AUTH_DB, { schema })
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1)
  const row = rows[0]
  if (!row) return
  if (row.userId === 'system') return

  if (row.visibility === 'public') {
    const PUBLIC_FANOUT_CAP = 100
    const presenceRows = await db.select({ userId: userPresence.userId }).from(userPresence)
    const set = new Set<string>()
    for (const r of presenceRows) set.add(r.userId)
    // Always include the owner even if they happen not to be in the
    // presence index (e.g. the row was just written and the owner has no
    // live UserSettings WS yet).
    set.add(row.userId)
    const targets = Array.from(set)
    if (targets.length > PUBLIC_FANOUT_CAP) {
      console.warn(
        `[broadcastSessionRow] public fanout cap hit: session=${sessionId} online=${targets.length} cap=${PUBLIC_FANOUT_CAP} — truncating`,
      )
      targets.length = PUBLIC_FANOUT_CAP
    }
    ctx.waitUntil(
      Promise.allSettled(
        targets.map((uid) =>
          broadcastSyncedDelta(env, uid, 'agent_sessions', [{ type: op, value: row }]),
        ),
      ),
    )
    return
  }

  ctx.waitUntil(broadcastSyncedDelta(env, row.userId, 'agent_sessions', [{ type: op, value: row }]))
}
