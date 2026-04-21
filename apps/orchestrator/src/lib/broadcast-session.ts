import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions } from '~/db/schema'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import type { Env } from '~/lib/types'

/**
 * Fire-and-forget broadcast of a single `agent_sessions` row to the owning
 * user's UserSettingsDO. Spec #37 B2.
 *
 * - SELECTs the full row by id; returns if row is gone (cascade-delete race).
 * - Skips broadcast if `userId === 'system'` (orphan-session suppression).
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

  ctx.waitUntil(broadcastSyncedDelta(env, row.userId, 'agent_sessions', [{ type: op, value: row }]))
}
