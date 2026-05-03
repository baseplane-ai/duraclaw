/**
 * GH#152 P1.5 WU-B — collab unread + mention helpers.
 *
 * Shared between `addCommentImpl` (SessionDO) and `addChatImpl`
 * (ArcCollabDO). Each write fans out two concerns:
 *   1. Bump per-(user, arc) unread counters for every member EXCEPT the
 *      author, channel-scoped (`unread_comments` / `unread_chat`).
 *   2. Insert one `arc_mentions` row per resolved mention target
 *      (excluding self-mentions of the actor), denormalising
 *      `actor_user_id` + `preview` so the Inbox view renders without
 *      JOINing back to the source table.
 *
 * Both effects broadcast a synced-collection delta on each affected
 * user's stream so the per-user `arcUnread` / `arcMentions`
 * collections stay live without a refetch. The D1 writes are awaited
 * (source of truth); the per-user broadcasts run under `ctx.waitUntil`
 * so the originating chat / comment POST returns fast.
 *
 * Per-member upsert: for an arc with N members this issues N `INSERT
 * ... ON CONFLICT DO UPDATE` statements per write. Acceptable for MVP;
 * a single multi-row upsert is a future optimisation.
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { arcMembers } from '~/db/schema'
import type { Env } from '~/lib/types'
import { broadcastSyncedDelta } from './broadcast-synced-delta'

interface WaitUntilCtx {
  waitUntil: (p: Promise<unknown>) => void
}

/** Truncate the body slice that fronts an arc_mentions row. */
const PREVIEW_MAX_LEN = 160

function clipPreview(preview: string): string {
  if (preview.length <= PREVIEW_MAX_LEN) return preview
  return preview.slice(0, PREVIEW_MAX_LEN)
}

/**
 * Bump the per-channel unread counter for every arc member except the
 * author. Composite-PK upsert: insert with the bump value when the row
 * is absent, otherwise increment in place. After the D1 writes settle,
 * fan a single `update`-shaped row to each affected user's `arcUnread`
 * SyncedCollection so the sidebar badge is live.
 *
 * Counter rows surface to the client keyed on `${userId}:${arcId}` so
 * TanStack DB can dedupe / patch in place without a composite-key tax.
 */
export async function incrementArcUnread(
  env: Env,
  ctx: WaitUntilCtx,
  arcId: string,
  channel: 'comments' | 'chat',
  authorUserId: string,
): Promise<void> {
  // Source of truth: re-query members from D1 every write. Avoids the
  // 60s TTL staleness on the broadcast-arc-room cache (different
  // contract — that one is acceptable-stale fanout; counters must be
  // exact). At one read + N writes per chat / comment, this is fine.
  let members: { userId: string }[]
  try {
    const db = drizzle(env.AUTH_DB, { schema })
    members = await db
      .select({ userId: arcMembers.userId })
      .from(arcMembers)
      .where(eq(arcMembers.arcId, arcId))
  } catch (err) {
    console.warn(`[collab-summary] loadMembers failed arc=${arcId}:`, err)
    return
  }

  const targets = members.map((m) => m.userId).filter((uid) => uid !== authorUserId)
  if (targets.length === 0) return

  const isComments = channel === 'comments'
  const updateSql = isComments
    ? `INSERT INTO arc_unread (user_id, arc_id, unread_comments, unread_chat,
                               last_read_comments_at, last_read_chat_at)
       VALUES (?, ?, 1, 0, NULL, NULL)
       ON CONFLICT(user_id, arc_id) DO UPDATE
         SET unread_comments = unread_comments + 1`
    : `INSERT INTO arc_unread (user_id, arc_id, unread_comments, unread_chat,
                               last_read_comments_at, last_read_chat_at)
       VALUES (?, ?, 0, 1, NULL, NULL)
       ON CONFLICT(user_id, arc_id) DO UPDATE
         SET unread_chat = unread_chat + 1`

  // Run upserts sequentially (per-row prepared) — D1 batch() would be
  // tighter, but this path runs per write (not per fanout target),
  // member counts are bounded, and sequential keeps the error reporting
  // simple. We DO await the writes (truth) but waitUntil-wrap the
  // broadcasts so the POST response is not blocked on per-user
  // UserSettingsDO RPC latency.
  const updated: Array<{
    userId: string
    unreadComments: number
    unreadChat: number
  }> = []

  for (const userId of targets) {
    try {
      await env.AUTH_DB.prepare(updateSql).bind(userId, arcId).run()
      // Re-read the row so the broadcast carries authoritative
      // counters (covers concurrent writers — last reader wins on the
      // client). One round-trip per target; could batch with a follow-
      // up SELECT-IN if hot.
      const row = await env.AUTH_DB.prepare(
        `SELECT unread_comments AS unreadComments, unread_chat AS unreadChat
           FROM arc_unread WHERE user_id = ? AND arc_id = ?`,
      )
        .bind(userId, arcId)
        .first<{ unreadComments: number; unreadChat: number }>()
      if (row) {
        updated.push({
          userId,
          unreadComments: row.unreadComments,
          unreadChat: row.unreadChat,
        })
      }
    } catch (err) {
      console.warn(
        `[collab-summary] arc_unread upsert failed user=${userId} arc=${arcId} channel=${channel}:`,
        err,
      )
    }
  }

  if (updated.length === 0) return

  // Fire-and-forget per-user broadcast.
  ctx.waitUntil(
    Promise.all(
      updated.map((u) =>
        broadcastSyncedDelta(env, u.userId, 'arcUnread', [
          {
            type: 'update',
            value: {
              id: `${u.userId}:${arcId}`,
              userId: u.userId,
              arcId,
              unreadComments: u.unreadComments,
              unreadChat: u.unreadChat,
            },
          },
        ]),
      ),
    ).then(() => undefined),
  )
}

export interface RecordMentionsArgs {
  arcId: string
  sourceKind: 'comment' | 'chat'
  sourceId: string
  actorUserId: string
  /** Verbatim body — truncated to PREVIEW_MAX_LEN here. */
  preview: string
  /** Pre-resolved (parseMentions) — actor is filtered out below. */
  resolvedUserIds: string[]
}

/**
 * Insert one `arc_mentions` row per resolved target (excluding the
 * actor) and broadcast the new rows on each target's `arcMentions`
 * SyncedCollection. `mention_ts` and `id` are minted here so callers
 * stay simple.
 *
 * No-op when the resolved list is empty after self-filtering.
 */
export async function recordMentions(
  env: Env,
  ctx: WaitUntilCtx,
  args: RecordMentionsArgs,
): Promise<void> {
  const targets = args.resolvedUserIds.filter((uid) => uid !== args.actorUserId)
  if (targets.length === 0) return

  const preview = clipPreview(args.preview)
  const mentionTs = new Date().toISOString()

  interface MentionWire {
    id: string
    userId: string
    arcId: string
    sourceKind: 'comment' | 'chat'
    sourceId: string
    actorUserId: string
    preview: string
    mentionTs: string
    readAt: string | null
  }
  const inserted: MentionWire[] = []

  for (const userId of targets) {
    const id = crypto.randomUUID()
    try {
      await env.AUTH_DB.prepare(
        `INSERT INTO arc_mentions
           (id, user_id, arc_id, source_kind, source_id, actor_user_id, preview, mention_ts, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
        .bind(
          id,
          userId,
          args.arcId,
          args.sourceKind,
          args.sourceId,
          args.actorUserId,
          preview,
          mentionTs,
        )
        .run()
      inserted.push({
        id,
        userId,
        arcId: args.arcId,
        sourceKind: args.sourceKind,
        sourceId: args.sourceId,
        actorUserId: args.actorUserId,
        preview,
        mentionTs,
        readAt: null,
      })
    } catch (err) {
      console.warn(
        `[collab-summary] arc_mentions insert failed user=${userId} arc=${args.arcId}:`,
        err,
      )
    }
  }

  if (inserted.length === 0) return

  ctx.waitUntil(
    Promise.all(
      inserted.map((m) =>
        broadcastSyncedDelta(env, m.userId, 'arcMentions', [{ type: 'insert', value: m }]),
      ),
    ).then(() => undefined),
  )
}
