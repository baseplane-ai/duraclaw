import type { ReactionRow } from '@duraclaw/shared-types'
import { broadcastArcRoom } from '~/lib/broadcast-arc-room'
import type { ArcCollabDOContext } from './rpc-chat'

/**
 * GH#152 P1.4 B12: per-reaction RPC handlers for ArcCollabDO.
 *
 * Mirrors `rpc-chat.ts` shape — `ArcCollabDOContext` in, a
 * `{ok, status, ...}` result out. The HTTP layer in `arc-collab-do.ts`
 * (`onRequest` override) maps that shape to the Hono response.
 *
 * Storage: writes land in the per-DO `reactions` SQLite table (created
 * in `ensureTables()`). Composite PK `(target_kind, target_id, user_id,
 * emoji)` enforces "one user one emoji per target" — toggling re-presses
 * the same key.
 *
 * No D1 mirror: reactions are high-frequency and ephemeral; the DO row
 * is the single source of truth. Cross-arc reaction analytics, if ever
 * needed, are a follow-up.
 *
 * Synthetic id (`${targetKind}:${targetId}:${userId}:${emoji}`) gives
 * TanStack DB a single string key per row in the `reactions:<arcId>`
 * synced collection.
 */

type ReactionTargetKind = 'comment' | 'chat'

type ReactionSqlRow = {
  target_kind: string
  target_id: string
  user_id: string
  emoji: string
  created_at: number
  [key: string]: SqlStorageValue
}

const MAX_EMOJI_LEN = 16
const COLD_LOAD_LIMIT = 1000

function syntheticId(
  targetKind: ReactionTargetKind,
  targetId: string,
  userId: string,
  emoji: string,
): string {
  return `${targetKind}:${targetId}:${userId}:${emoji}`
}

function rowToWire(row: ReactionSqlRow): ReactionRow {
  const targetKind = row.target_kind as ReactionTargetKind
  return {
    targetKind,
    targetId: row.target_id,
    userId: row.user_id,
    emoji: row.emoji,
    createdAt: row.created_at,
    id: syntheticId(targetKind, row.target_id, row.user_id, row.emoji),
  }
}

/** Channel name for the SyncedCollection wire scope. */
function reactionsChannel(arcId: string): string {
  return `reactions:${arcId}`
}

// ── toggle ──────────────────────────────────────────────────────────────

export interface ToggleReactionArgs {
  targetKind: string
  targetId: string
  emoji: string
  userId: string
}

export type ToggleReactionResult =
  | { ok: true; row: ReactionRow; action: 'added' | 'removed'; status: 200 }
  | {
      ok: false
      error:
        | 'invalid_target_kind'
        | 'invalid_target_id'
        | 'invalid_emoji'
        | 'unauthenticated'
        | 'internal_error'
      status: 401 | 422 | 500
    }

export async function toggleReactionImpl(
  ctx: ArcCollabDOContext,
  args: ToggleReactionArgs,
): Promise<ToggleReactionResult> {
  if (typeof args.userId !== 'string' || args.userId.length === 0) {
    return { ok: false, error: 'unauthenticated', status: 401 }
  }
  if (args.targetKind !== 'comment' && args.targetKind !== 'chat') {
    return { ok: false, error: 'invalid_target_kind', status: 422 }
  }
  if (typeof args.targetId !== 'string' || args.targetId.length === 0) {
    return { ok: false, error: 'invalid_target_id', status: 422 }
  }
  if (
    typeof args.emoji !== 'string' ||
    args.emoji.length === 0 ||
    args.emoji.length > MAX_EMOJI_LEN
  ) {
    return { ok: false, error: 'invalid_emoji', status: 422 }
  }

  const targetKind = args.targetKind as ReactionTargetKind
  const targetId = args.targetId
  const userId = args.userId
  const emoji = args.emoji
  const arcId = ctx.do.name
  const sid = syntheticId(targetKind, targetId, userId, emoji)

  // Look up existing row by composite PK.
  const existing = [
    ...ctx.sql.exec<ReactionSqlRow>(
      `SELECT target_kind, target_id, user_id, emoji, created_at
       FROM reactions
       WHERE target_kind = ? AND target_id = ? AND user_id = ? AND emoji = ?
       LIMIT 1`,
      targetKind,
      targetId,
      userId,
      emoji,
    ),
  ]

  if (existing.length > 0) {
    // Toggle off — DELETE + broadcast delete.
    try {
      ctx.sql.exec(
        `DELETE FROM reactions
         WHERE target_kind = ? AND target_id = ? AND user_id = ? AND emoji = ?`,
        targetKind,
        targetId,
        userId,
        emoji,
      )
    } catch (err) {
      console.error(`[ArcCollabDO:${ctx.ctx.id}] toggleReactionImpl DELETE failed:`, err)
      return { ok: false, error: 'internal_error', status: 500 }
    }
    const wire = rowToWire(existing[0])
    await broadcastArcRoom<ReactionRow>(ctx.env, ctx.ctx, arcId, reactionsChannel(arcId), [
      { type: 'delete', key: sid },
    ])
    return { ok: true, row: wire, action: 'removed', status: 200 }
  }

  // Toggle on — INSERT + broadcast insert.
  const now = Date.now()
  try {
    ctx.sql.exec(
      `INSERT INTO reactions (target_kind, target_id, user_id, emoji, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      targetKind,
      targetId,
      userId,
      emoji,
      now,
    )
  } catch (err) {
    console.error(`[ArcCollabDO:${ctx.ctx.id}] toggleReactionImpl INSERT failed:`, err)
    return { ok: false, error: 'internal_error', status: 500 }
  }
  const wire: ReactionRow = {
    targetKind,
    targetId,
    userId,
    emoji,
    createdAt: now,
    id: sid,
  }
  await broadcastArcRoom<ReactionRow>(ctx.env, ctx.ctx, arcId, reactionsChannel(arcId), [
    { type: 'insert', value: wire },
  ])
  return { ok: true, row: wire, action: 'added', status: 200 }
}

// ── list ────────────────────────────────────────────────────────────────

export interface ListReactionsArgs {
  // Reserved for future cursor-aware replay; unused today.
  sinceCursor?: { createdAt: number; id: string } | null
}

export interface ListReactionsResult {
  reactions: ReactionRow[]
}

/**
 * Cold-load read of per-arc reactions. Returns the latest N (capped at
 * 1000 — reactions are small and cheap). No cursor today; warm-reconnect
 * relies on the broadcast stream alone.
 */
export function listReactionsForArc(
  ctx: ArcCollabDOContext,
  _args: ListReactionsArgs,
): ListReactionsResult {
  const rows = [
    ...ctx.sql.exec<ReactionSqlRow>(
      `SELECT target_kind, target_id, user_id, emoji, created_at
       FROM reactions
       ORDER BY created_at DESC
       LIMIT ?`,
      COLD_LOAD_LIMIT,
    ),
  ]
  return { reactions: rows.map(rowToWire) }
}
