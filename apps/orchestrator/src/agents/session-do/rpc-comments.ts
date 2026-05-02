import type { CommentRow } from '@duraclaw/shared-types'
import { eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import { broadcastComments } from './broadcast'
import type { SessionDOContext } from './types'

/**
 * GH#152 P1.2 WU-B: per-message comment RPC handlers.
 *
 * Mirrors `rpc-messages.ts:47-200`'s shape — `SessionDOContext` in, a
 * `{ok, status, ...}` result out. The HTTP layer in `http-routes.ts`
 * maps that shape to the Hono response (status code + JSON body).
 *
 * Storage segregation (B24): all writes land in the `comments` table
 * (DO migration v23). The SDK-owned `assistant_messages` table is read
 * only here (existence check for the parent message) — never mutated.
 *
 * Idempotency: `addCommentImpl` uses the existing per-DO `submit_ids`
 * table (DO migration v5, 60s TTL) keyed on `clientCommentId`. A
 * duplicate POST returns the cached comment row (loaded fresh from
 * the `comments` table by id, since the comment id IS the
 * clientCommentId).
 *
 * Author attribution comes from the HTTP layer, which extracts
 * `userSession.userId` (B2 handshake) and forwards it as `senderId`.
 * Future WS-RPC entrypoints will source the same value from
 * `connection.state.userId` (`SessionClientConnectionState`).
 */

/** Minimal tagged-template SQL interface — matches the helper shape in history.ts. */
type SqlFn = <T>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[]

/** How long a clientCommentId stays in submit_ids before being pruned. */
const SUBMIT_ID_TTL_MS = 60_000

type CommentSqlRow = {
  id: string
  arc_id: string
  session_id: string
  message_id: string
  parent_comment_id: string | null
  author_user_id: string
  body: string
  created_at: number
  modified_at: number
  edited_at: number | null
  deleted_at: number | null
  deleted_by: string | null
  [key: string]: SqlStorageValue
}

function rowToWire(row: CommentSqlRow): CommentRow {
  return {
    id: row.id,
    arcId: row.arc_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    parentCommentId: row.parent_comment_id,
    authorUserId: row.author_user_id,
    body: row.body,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  }
}

function loadCommentById(ctx: SessionDOContext, commentId: string): CommentSqlRow | null {
  const rows = [
    ...ctx.sql.exec<CommentSqlRow>(
      `SELECT id, arc_id, session_id, message_id, parent_comment_id, author_user_id,
              body, created_at, modified_at, edited_at, deleted_at, deleted_by
       FROM comments WHERE id = ? LIMIT 1`,
      commentId,
    ),
  ]
  return rows[0] ?? null
}

async function loadArcIdForSession(ctx: SessionDOContext): Promise<string | null> {
  const sessionId = ctx.do.name
  try {
    const rows = await ctx.do.d1
      .select({ arcId: agentSessions.arcId })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
    return rows[0]?.arcId ?? null
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] loadArcIdForSession failed:`, err)
    return null
  }
}

// ── add ────────────────────────────────────────────────────────────────

export interface AddCommentArgs {
  messageId: string
  parentCommentId?: string | null
  body: string
  clientCommentId: string
  senderId?: string | null
}

export type AddCommentResult =
  | { ok: true; comment: CommentRow; status: 200 }
  | {
      ok: false
      error:
        | 'body_required'
        | 'message_not_found'
        | 'parent_not_found'
        | 'message_streaming'
        | 'invalid_client_comment_id'
        | 'arc_not_found'
        | 'internal_error'
      status: 404 | 409 | 422 | 500
    }

export async function addCommentImpl(
  ctx: SessionDOContext,
  args: AddCommentArgs,
): Promise<AddCommentResult> {
  // 1. body required
  if (typeof args.body !== 'string' || args.body.trim().length === 0) {
    return { ok: false, error: 'body_required', status: 422 }
  }

  // clientCommentId: required and bounded length (mirrors history.ts SUBMIT_ID_MAX_LEN).
  if (
    typeof args.clientCommentId !== 'string' ||
    args.clientCommentId.length === 0 ||
    args.clientCommentId.length > 64
  ) {
    return { ok: false, error: 'invalid_client_comment_id', status: 422 }
  }

  const sessionId = ctx.do.name

  // 5 (early): idempotency — if we've already accepted this clientCommentId,
  // load the comment row (id === clientCommentId) and return it. Submit_ids
  // here is per-DO, the same table sendMessage uses (60s TTL).
  const sqlTagged = ctx.do.sql.bind(ctx.do) as unknown as SqlFn
  const submitHit = [
    ...sqlTagged<{
      id: string
    }>`SELECT id FROM submit_ids WHERE id = ${args.clientCommentId} LIMIT 1`,
  ]
  if (submitHit.length > 0) {
    const existing = loadCommentById(ctx, args.clientCommentId)
    if (existing) {
      return { ok: true, comment: rowToWire(existing), status: 200 }
    }
    // Defensive: submit_ids hit but row missing (race/cleanup). Fall through
    // and re-insert — the INSERT below uses the same clientCommentId as id
    // so a unique-constraint failure would surface here, but in practice the
    // row should always exist when the submit_id is present.
  }

  // 2. message exists in this session's assistant_messages
  const msgHit = [
    ...ctx.sql.exec<{ id: string }>(
      `SELECT id FROM assistant_messages WHERE id = ? AND session_id = '' LIMIT 1`,
      args.messageId,
    ),
  ]
  if (msgHit.length === 0) {
    return { ok: false, error: 'message_not_found', status: 404 }
  }

  // 3. parent comment exists in this session's comments (when supplied)
  if (args.parentCommentId) {
    const parentHit = [
      ...ctx.sql.exec<{ id: string }>(
        `SELECT id FROM comments WHERE id = ? AND session_id = ? LIMIT 1`,
        args.parentCommentId,
        sessionId,
      ),
    ]
    if (parentHit.length === 0) {
      return { ok: false, error: 'parent_not_found', status: 422 }
    }
  }

  // 4. lock-during-stream gate. WU-C wires the actual streamingMessageIds set
  // in gateway-event-handler.ts; for WU-B the set is always empty so this is
  // a no-op scaffold.
  if (ctx.do.streamingMessageIds.has(args.messageId)) {
    return { ok: false, error: 'message_streaming', status: 409 }
  }

  // Resolve arcId for the row. Required by the schema (NOT NULL); if the
  // session has no arcId we surface a 500 rather than silently dropping.
  const arcId = await loadArcIdForSession(ctx)
  if (!arcId) {
    return { ok: false, error: 'arc_not_found', status: 500 }
  }

  const now = Date.now()
  const id = args.clientCommentId
  const parentCommentId = args.parentCommentId ?? null
  const authorUserId = args.senderId ?? ''

  try {
    ctx.sql.exec(
      `INSERT INTO comments (id, arc_id, session_id, message_id, parent_comment_id,
                             author_user_id, body, created_at, modified_at,
                             edited_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      id,
      arcId,
      sessionId,
      args.messageId,
      parentCommentId,
      authorUserId,
      args.body,
      now,
      now,
    )
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] addCommentImpl INSERT failed:`, err)
    return { ok: false, error: 'internal_error', status: 500 }
  }

  // Record the clientCommentId in submit_ids so a retry within 60s
  // short-circuits to the cached row. Mirrors claimSubmitId's prune step.
  try {
    sqlTagged`INSERT OR IGNORE INTO submit_ids (id, created_at) VALUES (${id}, ${now})`
    const cutoff = now - SUBMIT_ID_TTL_MS
    sqlTagged`DELETE FROM submit_ids WHERE created_at < ${cutoff}`
  } catch (err) {
    // Non-fatal: the insert above already succeeded; an idempotency-table
    // hiccup means a retry might double-write, but the comment id is the
    // primary key so the second INSERT would fail on the unique constraint
    // and we'd return the existing row via the loadCommentById path.
    console.warn(`[SessionDO:${ctx.ctx.id}] submit_ids upkeep failed:`, err)
  }

  const wire: CommentRow = {
    id,
    arcId,
    sessionId,
    messageId: args.messageId,
    parentCommentId,
    authorUserId,
    body: args.body,
    createdAt: now,
    modifiedAt: now,
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
  }
  broadcastComments(ctx, [{ type: 'insert', value: wire }])
  return { ok: true, comment: wire, status: 200 }
}

// ── edit ───────────────────────────────────────────────────────────────

export interface EditCommentArgs {
  commentId: string
  body: string
  senderId?: string | null
}

export type EditCommentResult =
  | { ok: true; comment: CommentRow; status: 200 }
  | {
      ok: false
      error: 'body_required' | 'comment_not_found' | 'comment_deleted' | 'not_author'
      status: 403 | 404 | 410 | 422
    }

export function editCommentImpl(ctx: SessionDOContext, args: EditCommentArgs): EditCommentResult {
  if (typeof args.body !== 'string' || args.body.trim().length === 0) {
    return { ok: false, error: 'body_required', status: 422 }
  }
  const row = loadCommentById(ctx, args.commentId)
  if (!row) return { ok: false, error: 'comment_not_found', status: 404 }
  if (row.deleted_at !== null) {
    return { ok: false, error: 'comment_deleted', status: 410 }
  }
  if (row.author_user_id !== (args.senderId ?? '')) {
    return { ok: false, error: 'not_author', status: 403 }
  }

  const now = Date.now()
  ctx.sql.exec(
    `UPDATE comments SET body = ?, edited_at = ?, modified_at = ? WHERE id = ?`,
    args.body,
    now,
    now,
    args.commentId,
  )
  const updated: CommentSqlRow = {
    ...row,
    body: args.body,
    edited_at: now,
    modified_at: now,
  }
  const wire = rowToWire(updated)
  broadcastComments(ctx, [{ type: 'update', value: wire }])
  return { ok: true, comment: wire, status: 200 }
}

// ── delete ─────────────────────────────────────────────────────────────

export interface DeleteCommentArgs {
  commentId: string
  senderId?: string | null
  callerRole: 'owner' | 'member' | 'admin' | null
}

export type DeleteCommentResult =
  | { ok: true; comment: CommentRow; status: 200 }
  | { ok: false; error: 'comment_not_found' | 'forbidden'; status: 403 | 404 }

export function deleteCommentImpl(
  ctx: SessionDOContext,
  args: DeleteCommentArgs,
): DeleteCommentResult {
  const row = loadCommentById(ctx, args.commentId)
  if (!row) return { ok: false, error: 'comment_not_found', status: 404 }

  const senderId = args.senderId ?? ''
  const isAuthor = senderId !== '' && row.author_user_id === senderId
  const isOwner = args.callerRole === 'owner'
  const isAdmin = args.callerRole === 'admin'
  if (!isAuthor && !isOwner && !isAdmin) {
    return { ok: false, error: 'forbidden', status: 403 }
  }

  // Idempotent: if already soft-deleted, return the existing tombstone row.
  if (row.deleted_at !== null) {
    return { ok: true, comment: rowToWire(row), status: 200 }
  }

  const now = Date.now()
  ctx.sql.exec(
    `UPDATE comments SET deleted_at = ?, deleted_by = ?, modified_at = ? WHERE id = ?`,
    now,
    senderId || null,
    now,
    args.commentId,
  )
  const updated: CommentSqlRow = {
    ...row,
    deleted_at: now,
    deleted_by: senderId || null,
    modified_at: now,
  }
  const wire = rowToWire(updated)
  broadcastComments(ctx, [{ type: 'update', value: wire }])
  return { ok: true, comment: wire, status: 200 }
}

// ── list ───────────────────────────────────────────────────────────────

export interface ListCommentsArgs {
  messageId: string
}

export interface ListCommentsResult {
  comments: CommentRow[]
}

export function listCommentsForMessage(
  ctx: SessionDOContext,
  args: ListCommentsArgs,
): ListCommentsResult {
  const sessionId = ctx.do.name
  const rows = [
    ...ctx.sql.exec<CommentSqlRow>(
      `SELECT id, arc_id, session_id, message_id, parent_comment_id, author_user_id,
              body, created_at, modified_at, edited_at, deleted_at, deleted_by
       FROM comments
       WHERE session_id = ? AND message_id = ?
       ORDER BY created_at ASC, id ASC`,
      sessionId,
      args.messageId,
    ),
  ]
  return { comments: rows.map(rowToWire) }
}
