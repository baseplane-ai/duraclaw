import type { ChatMessageRow } from '@duraclaw/shared-types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { chatMirror } from '~/db/schema'
import { broadcastArcRoom } from '~/lib/broadcast-arc-room'
import { incrementArcUnread, recordMentions } from '~/lib/collab-summary'
import { parseMentions } from '~/lib/parse-mentions'
import type { Env } from '~/lib/types'

/**
 * GH#152 P1.3 WU-C: per-message chat RPC handlers for ArcCollabDO.
 *
 * Mirrors `agents/session-do/rpc-comments.ts` exactly — `ArcCollabDOContext`
 * in, a `{ok, status, ...}` result out. The HTTP layer in
 * `arc-collab-do.ts` (`onRequest` override) maps that shape to the
 * Hono response (status code + JSON body).
 *
 * Storage: writes land in the per-DO `chat_messages` SQLite table
 * (created in `ensureTables()` at DO-migration v8). The Y.Doc surface
 * is reserved for the P1.6 awareness work — chat is row-shaped, not
 * CRDT-shaped, so it lives in plain SQLite alongside the Y.Doc
 * snapshot.
 *
 * Idempotency: `addChatImpl` uses the per-DO `submit_ids` table
 * (60s TTL), keyed on `clientChatId`. A duplicate POST returns the
 * cached chat row (id === clientChatId).
 *
 * Author attribution: HTTP layer extracts `userSession.userId` from
 * the `x-user-id` header (stamped by the API forwarder) and passes
 * it as `senderId`.
 *
 * D1 mirror: every successful write is mirrored to `chat_mirror` via
 * `ctx.ctx.waitUntil(...)`. Mirror failures are logged but do not
 * abort the broadcast — the DO row is the source of truth.
 */

/** How long a clientChatId stays in submit_ids before being pruned. */
const SUBMIT_ID_TTL_MS = 60_000

/**
 * Live-reference bag passed to every chat RPC. `do.name` is the arc
 * id (DO-name == arc-id by convention). `sql` is the lower-level
 * positional-arg `SqlStorage` handle (== `this.ctx.storage.sql` on
 * the DO).
 */
export interface ArcCollabDOContext {
  do: {
    name: string
  }
  ctx: {
    id: DurableObjectId
    storage: DurableObjectStorage
    waitUntil: (p: Promise<unknown>) => void
  }
  env: Env
  sql: SqlStorage
}

type ChatSqlRow = {
  id: string
  arc_id: string
  author_user_id: string
  body: string
  mentions: string | null
  created_at: number
  modified_at: number
  edited_at: number | null
  deleted_at: number | null
  deleted_by: string | null
  [key: string]: SqlStorageValue
}

function rowToWire(row: ChatSqlRow): ChatMessageRow {
  let mentions: string[] | null = null
  if (row.mentions != null && row.mentions !== '') {
    try {
      const parsed = JSON.parse(row.mentions) as unknown
      if (Array.isArray(parsed)) {
        mentions = parsed.filter((v): v is string => typeof v === 'string')
      }
    } catch {
      mentions = null
    }
  }
  return {
    id: row.id,
    arcId: row.arc_id,
    authorUserId: row.author_user_id,
    body: row.body,
    mentions,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  }
}

function loadChatById(ctx: ArcCollabDOContext, chatId: string): ChatSqlRow | null {
  const rows = [
    ...ctx.sql.exec<ChatSqlRow>(
      `SELECT id, arc_id, author_user_id, body, mentions,
              created_at, modified_at, edited_at, deleted_at, deleted_by
       FROM chat_messages WHERE id = ? LIMIT 1`,
      chatId,
    ),
  ]
  return rows[0] ?? null
}

function epochMsToIso(ms: number | null): string | null {
  if (ms === null) return null
  return new Date(ms).toISOString()
}

/** Channel name for the SyncedCollection wire scope. */
function chatChannel(arcId: string): string {
  return `arcChat:${arcId}`
}

async function mirrorInsertToD1(env: Env, row: ChatMessageRow): Promise<void> {
  try {
    const db = drizzle(env.AUTH_DB, { schema })
    await db.insert(chatMirror).values({
      id: row.id,
      arcId: row.arcId,
      authorUserId: row.authorUserId,
      body: row.body,
      mentions: row.mentions ? JSON.stringify(row.mentions) : null,
      createdAt: epochMsToIso(row.createdAt) ?? new Date().toISOString(),
      modifiedAt: epochMsToIso(row.modifiedAt) ?? new Date().toISOString(),
      editedAt: epochMsToIso(row.editedAt),
      deletedAt: epochMsToIso(row.deletedAt),
      deletedBy: row.deletedBy,
    })
  } catch (err) {
    console.warn('[arc-collab-do:rpc-chat] D1 mirror insert failed:', err)
  }
}

async function mirrorUpdateToD1(env: Env, row: ChatMessageRow): Promise<void> {
  try {
    const db = drizzle(env.AUTH_DB, { schema })
    await db
      .update(chatMirror)
      .set({
        body: row.body,
        mentions: row.mentions ? JSON.stringify(row.mentions) : null,
        modifiedAt: epochMsToIso(row.modifiedAt) ?? new Date().toISOString(),
        editedAt: epochMsToIso(row.editedAt),
        deletedAt: epochMsToIso(row.deletedAt),
        deletedBy: row.deletedBy,
      })
      .where(eq(chatMirror.id, row.id))
  } catch (err) {
    console.warn('[arc-collab-do:rpc-chat] D1 mirror update failed:', err)
  }
}

// ── add ────────────────────────────────────────────────────────────────

export interface AddChatArgs {
  body: string
  clientChatId: string
  senderId?: string | null
}

export type AddChatResult =
  | { ok: true; chat: ChatMessageRow; status: 200 }
  | {
      ok: false
      error: 'body_required' | 'invalid_client_chat_id' | 'internal_error'
      status: 422 | 500
    }

export async function addChatImpl(
  ctx: ArcCollabDOContext,
  args: AddChatArgs,
): Promise<AddChatResult> {
  if (typeof args.body !== 'string' || args.body.trim().length === 0) {
    return { ok: false, error: 'body_required', status: 422 }
  }
  if (
    typeof args.clientChatId !== 'string' ||
    args.clientChatId.length === 0 ||
    args.clientChatId.length > 64
  ) {
    return { ok: false, error: 'invalid_client_chat_id', status: 422 }
  }

  const arcId = ctx.do.name

  // Idempotency — if this clientChatId was seen within the TTL, return
  // the existing row. Mirrors the addCommentImpl pattern.
  const submitHit = [
    ...ctx.sql.exec<{ id: string }>(
      `SELECT id FROM submit_ids WHERE id = ? LIMIT 1`,
      args.clientChatId,
    ),
  ]
  if (submitHit.length > 0) {
    const existing = loadChatById(ctx, args.clientChatId)
    if (existing) {
      return { ok: true, chat: rowToWire(existing), status: 200 }
    }
    // Defensive: submit_ids hit but row missing — fall through and
    // re-insert. The id is the PK, so a true duplicate would error.
  }

  const now = Date.now()
  const id = args.clientChatId
  const authorUserId = args.senderId ?? ''

  try {
    ctx.sql.exec(
      `INSERT INTO chat_messages (id, arc_id, author_user_id, body, mentions,
                                   created_at, modified_at, edited_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
      id,
      arcId,
      authorUserId,
      args.body,
      now,
      now,
    )
  } catch (err) {
    console.error(`[ArcCollabDO:${ctx.ctx.id}] addChatImpl INSERT failed:`, err)
    return { ok: false, error: 'internal_error', status: 500 }
  }

  // Record the clientChatId in submit_ids so a retry within the TTL
  // short-circuits to the cached row.
  try {
    ctx.sql.exec(`INSERT OR IGNORE INTO submit_ids (id, created_at) VALUES (?, ?)`, id, now)
    const cutoff = now - SUBMIT_ID_TTL_MS
    ctx.sql.exec(`DELETE FROM submit_ids WHERE created_at < ?`, cutoff)
  } catch (err) {
    console.warn(`[ArcCollabDO:${ctx.ctx.id}] submit_ids upkeep failed:`, err)
  }

  // GH#152 P1.5 WU-B: resolve @-mentions, persist on the row, fan out
  // unread + mentions inbox writes. parseMentions hits D1
  // (arc_members ⋈ users); the inbox + counter writes are pushed under
  // waitUntil so the chat POST returns fast.
  let resolvedUserIds: string[] = []
  try {
    const result = await parseMentions(drizzle(ctx.env.AUTH_DB, { schema }), arcId, args.body)
    resolvedUserIds = result.resolvedUserIds
  } catch (err) {
    console.warn(`[ArcCollabDO:${ctx.ctx.id}] parseMentions failed:`, err)
  }

  if (resolvedUserIds.length > 0) {
    const mentionsJson = JSON.stringify(resolvedUserIds)
    try {
      ctx.sql.exec(`UPDATE chat_messages SET mentions = ? WHERE id = ?`, mentionsJson, id)
    } catch (err) {
      console.warn(`[ArcCollabDO:${ctx.ctx.id}] addChatImpl mentions UPDATE failed:`, err)
    }
  }

  const wire: ChatMessageRow = {
    id,
    arcId,
    authorUserId,
    body: args.body,
    mentions: resolvedUserIds.length > 0 ? resolvedUserIds : null,
    createdAt: now,
    modifiedAt: now,
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
  }

  // Member-aware fanout. waitUntil-wraps the per-user
  // UserSettingsDO RPC internally so the request response is not
  // blocked on fanout latency.
  await broadcastArcRoom(ctx.env, ctx.ctx, arcId, chatChannel(arcId), [
    { type: 'insert', value: wire },
  ])

  // Async D1 mirror — the DO row is the source of truth; mirror
  // failure must not break the broadcast.
  ctx.ctx.waitUntil(mirrorInsertToD1(ctx.env, wire))

  // Async collab-summary fanout: inbox + per-user unread counter.
  ctx.ctx.waitUntil(
    (async () => {
      if (resolvedUserIds.length > 0) {
        await recordMentions(ctx.env, ctx.ctx, {
          arcId,
          sourceKind: 'chat',
          sourceId: id,
          actorUserId: authorUserId,
          preview: args.body.slice(0, 160),
          resolvedUserIds,
        })
      }
      await incrementArcUnread(ctx.env, ctx.ctx, arcId, 'chat', authorUserId)
    })(),
  )

  return { ok: true, chat: wire, status: 200 }
}

// ── edit ───────────────────────────────────────────────────────────────

export interface EditChatArgs {
  chatId: string
  body: string
  senderId?: string | null
}

export type EditChatResult =
  | { ok: true; chat: ChatMessageRow; status: 200 }
  | {
      ok: false
      error: 'body_required' | 'chat_not_found' | 'chat_deleted' | 'not_author'
      status: 403 | 404 | 410 | 422
    }

export async function editChatImpl(
  ctx: ArcCollabDOContext,
  args: EditChatArgs,
): Promise<EditChatResult> {
  if (typeof args.body !== 'string' || args.body.trim().length === 0) {
    return { ok: false, error: 'body_required', status: 422 }
  }
  const row = loadChatById(ctx, args.chatId)
  if (!row) return { ok: false, error: 'chat_not_found', status: 404 }
  if (row.deleted_at !== null) {
    return { ok: false, error: 'chat_deleted', status: 410 }
  }
  if (row.author_user_id !== (args.senderId ?? '')) {
    return { ok: false, error: 'not_author', status: 403 }
  }

  const now = Date.now()
  ctx.sql.exec(
    `UPDATE chat_messages SET body = ?, edited_at = ?, modified_at = ? WHERE id = ?`,
    args.body,
    now,
    now,
    args.chatId,
  )
  const updated: ChatSqlRow = {
    ...row,
    body: args.body,
    edited_at: now,
    modified_at: now,
  }
  const wire = rowToWire(updated)
  const arcId = ctx.do.name
  await broadcastArcRoom(ctx.env, ctx.ctx, arcId, chatChannel(arcId), [
    { type: 'update', value: wire },
  ])
  ctx.ctx.waitUntil(mirrorUpdateToD1(ctx.env, wire))
  return { ok: true, chat: wire, status: 200 }
}

// ── delete ─────────────────────────────────────────────────────────────

export interface DeleteChatArgs {
  chatId: string
  senderId?: string | null
  callerRole: 'owner' | 'member' | 'admin' | null
}

export type DeleteChatResult =
  | { ok: true; chat: ChatMessageRow; status: 200 }
  | { ok: false; error: 'chat_not_found' | 'forbidden'; status: 403 | 404 }

export async function deleteChatImpl(
  ctx: ArcCollabDOContext,
  args: DeleteChatArgs,
): Promise<DeleteChatResult> {
  const row = loadChatById(ctx, args.chatId)
  if (!row) return { ok: false, error: 'chat_not_found', status: 404 }

  const senderId = args.senderId ?? ''
  const isAuthor = senderId !== '' && row.author_user_id === senderId
  const isOwner = args.callerRole === 'owner'
  const isAdmin = args.callerRole === 'admin'
  if (!isAuthor && !isOwner && !isAdmin) {
    return { ok: false, error: 'forbidden', status: 403 }
  }

  // Idempotent: if already soft-deleted, return the tombstone with
  // no second broadcast.
  if (row.deleted_at !== null) {
    return { ok: true, chat: rowToWire(row), status: 200 }
  }

  const now = Date.now()
  ctx.sql.exec(
    `UPDATE chat_messages SET deleted_at = ?, deleted_by = ?, modified_at = ? WHERE id = ?`,
    now,
    senderId || null,
    now,
    args.chatId,
  )
  const updated: ChatSqlRow = {
    ...row,
    deleted_at: now,
    deleted_by: senderId || null,
    modified_at: now,
  }
  const wire = rowToWire(updated)
  const arcId = ctx.do.name
  await broadcastArcRoom(ctx.env, ctx.ctx, arcId, chatChannel(arcId), [
    { type: 'update', value: wire },
  ])
  ctx.ctx.waitUntil(mirrorUpdateToD1(ctx.env, wire))
  return { ok: true, chat: wire, status: 200 }
}

// ── list ───────────────────────────────────────────────────────────────

export interface ChatCursor {
  modifiedAt: number
  id: string
}

export interface ListChatArgs {
  sinceCursor?: ChatCursor | null
}

export interface ListChatResult {
  chat: ChatMessageRow[]
}

const COLD_LOAD_LIMIT = 200
const REPLAY_LIMIT = 500

/**
 * Cursor-aware read of the per-arc chat. Used for cold-load + warm
 * reconnect.
 *
 * - `sinceCursor` null/undefined → newest 200 by `(created_at DESC, id ASC)`,
 *   reversed before returning so the client renders chronologically.
 * - `sinceCursor` set → rows where `(modified_at, id) > sinceCursor`,
 *   ordered `(modified_at ASC, id ASC)`, capped at 500.
 *
 * Mirrors the messages-collection cursor-replay shape in SessionDO so
 * the synced-collection client wiring is symmetrical.
 */
export function listChatForArc(ctx: ArcCollabDOContext, args: ListChatArgs): ListChatResult {
  if (!args.sinceCursor) {
    const rows = [
      ...ctx.sql.exec<ChatSqlRow>(
        `SELECT id, arc_id, author_user_id, body, mentions,
                created_at, modified_at, edited_at, deleted_at, deleted_by
         FROM chat_messages
         ORDER BY created_at DESC, id ASC
         LIMIT ?`,
        COLD_LOAD_LIMIT,
      ),
    ]
    // Cold-load returns chronological order — reverse the DESC fetch.
    return { chat: rows.reverse().map(rowToWire) }
  }

  const { modifiedAt, id } = args.sinceCursor
  const rows = [
    ...ctx.sql.exec<ChatSqlRow>(
      `SELECT id, arc_id, author_user_id, body, mentions,
              created_at, modified_at, edited_at, deleted_at, deleted_by
       FROM chat_messages
       WHERE (modified_at > ?) OR (modified_at = ? AND id > ?)
       ORDER BY modified_at ASC, id ASC
       LIMIT ?`,
      modifiedAt,
      modifiedAt,
      id,
      REPLAY_LIMIT,
    ),
  ]
  return { chat: rows.map(rowToWire) }
}
