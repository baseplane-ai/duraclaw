import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#152 P1.2 WU-E — unit coverage for rpc-comments impls.
 *
 * Models test infra on `result-rate-limit.test.ts` + `transcript.test.ts`:
 * a hand-rolled in-memory SQL fake that knows just enough of the query
 * shapes the impls issue. Keeps the suite Workers-harness-free.
 */

vi.mock('./broadcast', () => ({
  broadcastComments: vi.fn(),
}))

import { broadcastComments } from './broadcast'
import {
  addCommentImpl,
  deleteCommentImpl,
  editCommentImpl,
  listCommentsForMessage,
} from './rpc-comments'
import type { SessionDOContext } from './types'

interface CommentRow {
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
}

interface AssistantMessageRow {
  id: string
  session_id: string
}

interface SubmitIdRow {
  id: string
  created_at: number
}

/**
 * In-memory SQL fake that handles the exact query shapes rpc-comments.ts
 * issues. Two surfaces exposed:
 *   - `exec(query, ...bindings)` — what `ctx.sql.exec(...)` calls.
 *   - `tag<T>(strings, ...values)` — the tagged-template form
 *     `ctx.do.sql\`...\`` reduces to (after `.bind(ctx.do)`).
 */
class FakeSql {
  comments: CommentRow[] = []
  assistantMessages: AssistantMessageRow[] = []
  submitIds: SubmitIdRow[] = []

  /**
   * `ctx.sql.exec(query, ...bindings)` — returns an iterable of rows.
   * Strict-match on the literal query shapes from rpc-comments.ts
   * (whitespace-collapsed) so any drift in the impl will surface as a
   * loud "unrecognised query shape" failure here.
   */
  exec<T = unknown>(query: string, ...bindings: unknown[]): { [Symbol.iterator](): Iterator<T> } {
    const q = query.replace(/\s+/g, ' ').trim()

    // SELECT id, arc_id, session_id, message_id, parent_comment_id, author_user_id,
    //        body, created_at, modified_at, edited_at, deleted_at, deleted_by
    // FROM comments WHERE id = ? LIMIT 1
    if (/^SELECT id, arc_id, session_id.*FROM comments WHERE id = \? LIMIT 1$/.test(q)) {
      const [id] = bindings as [string]
      const row = this.comments.find((r) => r.id === id)
      return iter(row ? [row as unknown as T] : [])
    }

    // SELECT id, arc_id, ... FROM comments WHERE session_id = ? AND message_id = ?
    // ORDER BY created_at ASC, id ASC
    if (/FROM comments WHERE session_id = \? AND message_id = \? ORDER BY/.test(q)) {
      const [sessionId, messageId] = bindings as [string, string]
      const matching = this.comments
        .filter((r) => r.session_id === sessionId && r.message_id === messageId)
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      return iter(matching.map((r) => r as unknown as T))
    }

    // SELECT id FROM assistant_messages WHERE id = ? AND session_id = '' LIMIT 1
    if (/^SELECT id FROM assistant_messages WHERE id = \? AND session_id = '' LIMIT 1$/.test(q)) {
      const [id] = bindings as [string]
      const row = this.assistantMessages.find((r) => r.id === id)
      return iter(row ? [{ id: row.id } as unknown as T] : [])
    }

    // SELECT id FROM comments WHERE id = ? AND session_id = ? LIMIT 1
    if (/^SELECT id FROM comments WHERE id = \? AND session_id = \? LIMIT 1$/.test(q)) {
      const [id, sessionId] = bindings as [string, string]
      const row = this.comments.find((r) => r.id === id && r.session_id === sessionId)
      return iter(row ? [{ id: row.id } as unknown as T] : [])
    }

    // INSERT INTO comments (...) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    if (/^INSERT INTO comments/.test(q)) {
      const [
        id,
        arc_id,
        session_id,
        message_id,
        parent_comment_id,
        author_user_id,
        body,
        created_at,
        modified_at,
      ] = bindings as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
        number,
        number,
      ]
      // Mimic primary-key uniqueness — the real DO would throw.
      if (this.comments.some((r) => r.id === id)) {
        throw new Error(`UNIQUE constraint failed: comments.id`)
      }
      this.comments.push({
        id,
        arc_id,
        session_id,
        message_id,
        parent_comment_id,
        author_user_id,
        body,
        created_at,
        modified_at,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
      })
      return iter<T>([])
    }

    // UPDATE comments SET body = ?, edited_at = ?, modified_at = ? WHERE id = ?
    if (/^UPDATE comments SET body = \?, edited_at = \?, modified_at = \? WHERE id = \?$/.test(q)) {
      const [body, editedAt, modifiedAt, id] = bindings as [string, number, number, string]
      const row = this.comments.find((r) => r.id === id)
      if (row) {
        row.body = body
        row.edited_at = editedAt
        row.modified_at = modifiedAt
      }
      return iter<T>([])
    }

    // UPDATE comments SET deleted_at = ?, deleted_by = ?, modified_at = ? WHERE id = ?
    if (
      /^UPDATE comments SET deleted_at = \?, deleted_by = \?, modified_at = \? WHERE id = \?$/.test(
        q,
      )
    ) {
      const [deletedAt, deletedBy, modifiedAt, id] = bindings as [
        number,
        string | null,
        number,
        string,
      ]
      const row = this.comments.find((r) => r.id === id)
      if (row) {
        row.deleted_at = deletedAt
        row.deleted_by = deletedBy
        row.modified_at = modifiedAt
      }
      return iter<T>([])
    }

    throw new Error(`FakeSql.exec: unrecognised query shape: ${q}`)
  }

  /**
   * Tagged-template form: `ctx.do.sql\`SELECT ... ${value} ...\``. After
   * `.bind(ctx.do)`, the body is invoked with (TemplateStringsArray,
   * ...values). We rebuild the literal SQL from the template parts to
   * pattern-match on it.
   */
  tag<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
    const composed = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '')
    const q = composed.replace(/\s+/g, ' ').trim()

    // SELECT id FROM submit_ids WHERE id = ? LIMIT 1
    if (/^SELECT id FROM submit_ids WHERE id = \? LIMIT 1$/.test(q)) {
      const [id] = values as [string]
      const row = this.submitIds.find((r) => r.id === id)
      return row ? ([{ id: row.id }] as T[]) : []
    }

    // INSERT OR IGNORE INTO submit_ids (id, created_at) VALUES (?, ?)
    if (/^INSERT OR IGNORE INTO submit_ids/.test(q)) {
      const [id, createdAt] = values as [string, number]
      if (!this.submitIds.some((r) => r.id === id)) {
        this.submitIds.push({ id, created_at: createdAt })
      }
      return [] as T[]
    }

    // DELETE FROM submit_ids WHERE created_at < ?
    if (/^DELETE FROM submit_ids WHERE created_at < \?$/.test(q)) {
      const [cutoff] = values as [number]
      this.submitIds = this.submitIds.filter((r) => r.created_at >= cutoff)
      return [] as T[]
    }

    throw new Error(`FakeSql.tag: unrecognised query shape: ${q}`)
  }
}

function iter<T>(values: T[]): { [Symbol.iterator](): Iterator<T> } {
  return {
    [Symbol.iterator]() {
      let i = 0
      return {
        next(): IteratorResult<T> {
          if (i < values.length) return { value: values[i++], done: false }
          return { value: undefined as unknown as T, done: true }
        },
      }
    },
  }
}

interface CtxOpts {
  arcIdForSession?: string | null
  d1ShouldThrow?: boolean
  streamingMessageIds?: Set<string>
  sessionName?: string
}

function createCtx(sql: FakeSql, opts: CtxOpts = {}): SessionDOContext {
  const sessionName = opts.sessionName ?? 'sess-1'
  const arcId = opts.arcIdForSession === undefined ? 'arc-1' : opts.arcIdForSession

  // d1 stub: build a `ctx.do.d1.select(...).from(...).where(...).limit(...)`
  // chain that resolves to the arcId lookup the impl issues.
  const d1Limit = vi.fn(async () => {
    if (opts.d1ShouldThrow) throw new Error('d1 boom')
    return arcId === null ? [] : [{ arcId }]
  })
  const d1Where = vi.fn(() => ({ limit: d1Limit }))
  const d1From = vi.fn(() => ({ where: d1Where }))
  const d1Select = vi.fn(() => ({ from: d1From }))

  // The tagged-template binding: `ctx.do.sql.bind(ctx.do)` returns a
  // function that proxies to `sql.tag(...)`. Provide `.bind` returning
  // the bound proxy (the impl casts the result to SqlFn).
  const taggedFn = (strings: TemplateStringsArray, ...values: unknown[]) =>
    sql.tag(strings, ...values)
  const sqlBindable = Object.assign(taggedFn, {
    bind: (_thisArg: unknown) => taggedFn,
  })

  const self = {
    name: sessionName,
    streamingMessageIds: opts.streamingMessageIds ?? new Set<string>(),
    sql: sqlBindable,
    d1: { select: d1Select },
  }

  return {
    do: self,
    sql: sql as unknown as SqlStorage,
    ctx: { id: { toString: () => 'do-id-x' } },
  } as unknown as SessionDOContext
}

beforeEach(() => {
  vi.mocked(broadcastComments).mockClear()
})

describe('addCommentImpl', () => {
  it('inserts on the happy path and broadcasts a single insert op', async () => {
    const sql = new FakeSql()
    sql.assistantMessages.push({ id: 'msg-1', session_id: '' })
    const ctx = createCtx(sql)

    const res = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      body: 'hello',
      clientCommentId: 'cmt-1',
      senderId: 'user-A',
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(200)
    expect(res.comment.id).toBe('cmt-1')
    expect(res.comment.body).toBe('hello')
    expect(res.comment.arcId).toBe('arc-1')
    expect(res.comment.sessionId).toBe('sess-1')
    expect(res.comment.messageId).toBe('msg-1')
    expect(res.comment.parentCommentId).toBeNull()
    expect(res.comment.authorUserId).toBe('user-A')

    expect(broadcastComments).toHaveBeenCalledTimes(1)
    expect(broadcastComments).toHaveBeenCalledWith(
      ctx,
      expect.arrayContaining([expect.objectContaining({ type: 'insert' })]),
    )
    const call = vi.mocked(broadcastComments).mock.calls[0]
    const ops = call[1] as Array<{ type: string; value: unknown }>
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('insert')
    expect(ops[0].value).toMatchObject({ id: 'cmt-1', body: 'hello' })

    // Persisted in the comments store + submit_ids.
    expect(sql.comments).toHaveLength(1)
    expect(sql.submitIds.find((s) => s.id === 'cmt-1')).toBeTruthy()
  })

  it('rejects an empty body with body_required (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      body: '   ',
      clientCommentId: 'cmt-1',
    })
    expect(res).toEqual({ ok: false, error: 'body_required', status: 422 })
    expect(broadcastComments).not.toHaveBeenCalled()
  })

  it('rejects an oversized clientCommentId (>64 chars) with invalid_client_comment_id (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      body: 'x',
      clientCommentId: 'a'.repeat(65),
    })
    expect(res).toEqual({
      ok: false,
      error: 'invalid_client_comment_id',
      status: 422,
    })
  })

  it('returns message_not_found (404) when the assistant_messages row is missing', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await addCommentImpl(ctx, {
      messageId: 'no-such-msg',
      body: 'hi',
      clientCommentId: 'cmt-2',
    })
    expect(res).toEqual({ ok: false, error: 'message_not_found', status: 404 })
  })

  it('returns parent_not_found (422) when parentCommentId references a missing comment', async () => {
    const sql = new FakeSql()
    sql.assistantMessages.push({ id: 'msg-1', session_id: '' })
    const ctx = createCtx(sql)
    const res = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      body: 'reply',
      clientCommentId: 'cmt-3',
      parentCommentId: 'ghost-parent',
    })
    expect(res).toEqual({ ok: false, error: 'parent_not_found', status: 422 })
  })

  it('returns message_streaming (409) when the messageId is in streamingMessageIds', async () => {
    const sql = new FakeSql()
    sql.assistantMessages.push({ id: 'msg-1', session_id: '' })
    const ctx = createCtx(sql, { streamingMessageIds: new Set(['msg-1']) })
    const res = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      body: 'hi',
      clientCommentId: 'cmt-4',
    })
    expect(res).toEqual({ ok: false, error: 'message_streaming', status: 409 })
  })

  it('returns arc_not_found (500) when loadArcIdForSession resolves to null', async () => {
    const sql = new FakeSql()
    sql.assistantMessages.push({ id: 'msg-1', session_id: '' })
    const ctx = createCtx(sql, { arcIdForSession: null })
    const res = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      body: 'hi',
      clientCommentId: 'cmt-5',
    })
    expect(res).toEqual({ ok: false, error: 'arc_not_found', status: 500 })
  })

  it('is idempotent on the same clientCommentId — second call returns the cached row, no second broadcast', async () => {
    const sql = new FakeSql()
    sql.assistantMessages.push({ id: 'msg-1', session_id: '' })
    const ctx = createCtx(sql)

    const first = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      body: 'first',
      clientCommentId: 'cmt-dup',
      senderId: 'user-A',
    })
    expect(first.ok).toBe(true)
    expect(broadcastComments).toHaveBeenCalledTimes(1)

    const second = await addCommentImpl(ctx, {
      messageId: 'msg-1',
      // Body diff from the first attempt should be ignored — submit_ids
      // shortcuts to the cached row keyed on clientCommentId.
      body: 'second',
      clientCommentId: 'cmt-dup',
      senderId: 'user-A',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.status).toBe(200)
    expect(second.comment.body).toBe('first')
    expect(second.comment.id).toBe('cmt-dup')

    // No second broadcast and no second insert.
    expect(broadcastComments).toHaveBeenCalledTimes(1)
    expect(sql.comments).toHaveLength(1)
  })
})

describe('editCommentImpl', () => {
  function seedComment(sql: FakeSql, overrides: Partial<CommentRow> = {}): CommentRow {
    const row: CommentRow = {
      id: 'cmt-A',
      arc_id: 'arc-1',
      session_id: 'sess-1',
      message_id: 'msg-1',
      parent_comment_id: null,
      author_user_id: 'user-A',
      body: 'original',
      created_at: 1000,
      modified_at: 1000,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      ...overrides,
    }
    sql.comments.push(row)
    return row
  }

  it('returns not_author (403) when the senderId does not match', () => {
    const sql = new FakeSql()
    seedComment(sql)
    const ctx = createCtx(sql)
    const res = editCommentImpl(ctx, {
      commentId: 'cmt-A',
      body: 'edit',
      senderId: 'user-OTHER',
    })
    expect(res).toEqual({ ok: false, error: 'not_author', status: 403 })
    expect(broadcastComments).not.toHaveBeenCalled()
  })

  it('returns comment_deleted (410) when the row is already soft-deleted', () => {
    const sql = new FakeSql()
    seedComment(sql, { deleted_at: 2000, deleted_by: 'user-A' })
    const ctx = createCtx(sql)
    const res = editCommentImpl(ctx, {
      commentId: 'cmt-A',
      body: 'edit',
      senderId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'comment_deleted', status: 410 })
  })

  it('returns comment_not_found (404) for a missing comment id', () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = editCommentImpl(ctx, {
      commentId: 'no-such',
      body: 'x',
      senderId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'comment_not_found', status: 404 })
  })

  it('updates the body, stamps edited_at, and broadcasts an update op on the happy path', () => {
    const sql = new FakeSql()
    seedComment(sql)
    const ctx = createCtx(sql)
    const res = editCommentImpl(ctx, {
      commentId: 'cmt-A',
      body: 'edited body',
      senderId: 'user-A',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.comment.body).toBe('edited body')
    expect(res.comment.editedAt).not.toBeNull()
    expect(res.comment.modifiedAt).toBe(res.comment.editedAt)

    const stored = sql.comments[0]
    expect(stored.body).toBe('edited body')
    expect(stored.edited_at).not.toBeNull()

    expect(broadcastComments).toHaveBeenCalledTimes(1)
    const ops = vi.mocked(broadcastComments).mock.calls[0][1] as Array<{
      type: string
      value: unknown
    }>
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('update')
    expect(ops[0].value).toMatchObject({ id: 'cmt-A', body: 'edited body' })
  })
})

describe('deleteCommentImpl', () => {
  function seedComment(sql: FakeSql, overrides: Partial<CommentRow> = {}): CommentRow {
    const row: CommentRow = {
      id: 'cmt-A',
      arc_id: 'arc-1',
      session_id: 'sess-1',
      message_id: 'msg-1',
      parent_comment_id: null,
      author_user_id: 'user-A',
      body: 'doomed',
      created_at: 1000,
      modified_at: 1000,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      ...overrides,
    }
    sql.comments.push(row)
    return row
  }

  it('returns comment_not_found (404) for a missing comment id', () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = deleteCommentImpl(ctx, {
      commentId: 'no-such',
      senderId: 'user-A',
      callerRole: 'member',
    })
    expect(res).toEqual({ ok: false, error: 'comment_not_found', status: 404 })
  })

  it('returns forbidden (403) for a non-author non-owner non-admin caller', () => {
    const sql = new FakeSql()
    seedComment(sql)
    const ctx = createCtx(sql)
    const res = deleteCommentImpl(ctx, {
      commentId: 'cmt-A',
      senderId: 'user-OTHER',
      callerRole: 'member',
    })
    expect(res).toEqual({ ok: false, error: 'forbidden', status: 403 })
    expect(broadcastComments).not.toHaveBeenCalled()
  })

  it('soft-deletes for the author with deleted_by = senderId and broadcasts an update', () => {
    const sql = new FakeSql()
    seedComment(sql)
    const ctx = createCtx(sql)
    const res = deleteCommentImpl(ctx, {
      commentId: 'cmt-A',
      senderId: 'user-A',
      callerRole: 'member',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.comment.deletedAt).not.toBeNull()
    expect(res.comment.deletedBy).toBe('user-A')
    expect(sql.comments[0].deleted_at).not.toBeNull()
    expect(sql.comments[0].deleted_by).toBe('user-A')

    expect(broadcastComments).toHaveBeenCalledTimes(1)
    const ops = vi.mocked(broadcastComments).mock.calls[0][1] as Array<{
      type: string
      value: unknown
    }>
    expect(ops[0].type).toBe('update')
  })

  it("allows owner role to delete a different user's comment", () => {
    const sql = new FakeSql()
    seedComment(sql, { author_user_id: 'user-A' })
    const ctx = createCtx(sql)
    const res = deleteCommentImpl(ctx, {
      commentId: 'cmt-A',
      senderId: 'user-OWNER',
      callerRole: 'owner',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.comment.deletedBy).toBe('user-OWNER')
  })

  it("allows admin role to delete a different user's comment", () => {
    const sql = new FakeSql()
    seedComment(sql, { author_user_id: 'user-A' })
    const ctx = createCtx(sql)
    const res = deleteCommentImpl(ctx, {
      commentId: 'cmt-A',
      senderId: 'user-ADMIN',
      callerRole: 'admin',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.comment.deletedBy).toBe('user-ADMIN')
  })

  it('is idempotent on already-deleted rows: returns existing row, no second broadcast', () => {
    const sql = new FakeSql()
    seedComment(sql, { deleted_at: 5000, deleted_by: 'user-A' })
    const ctx = createCtx(sql)
    const res = deleteCommentImpl(ctx, {
      commentId: 'cmt-A',
      senderId: 'user-A',
      callerRole: 'member',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.comment.deletedAt).toBe(5000)
    expect(res.comment.deletedBy).toBe('user-A')
    expect(broadcastComments).not.toHaveBeenCalled()
  })
})

describe('listCommentsForMessage', () => {
  it('returns comments for the (sessionId, messageId) sorted by created_at ASC, id ASC', () => {
    const sql = new FakeSql()
    sql.comments.push(
      {
        id: 'cmt-c',
        arc_id: 'arc-1',
        session_id: 'sess-1',
        message_id: 'msg-1',
        parent_comment_id: null,
        author_user_id: 'u',
        body: 'third',
        created_at: 3000,
        modified_at: 3000,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
      },
      {
        id: 'cmt-a',
        arc_id: 'arc-1',
        session_id: 'sess-1',
        message_id: 'msg-1',
        parent_comment_id: null,
        author_user_id: 'u',
        body: 'first',
        created_at: 1000,
        modified_at: 1000,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
      },
      {
        id: 'cmt-b',
        arc_id: 'arc-1',
        session_id: 'sess-1',
        message_id: 'msg-1',
        parent_comment_id: null,
        author_user_id: 'u',
        body: 'second',
        created_at: 2000,
        modified_at: 2000,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
      },
      // A row on a different message must be filtered out.
      {
        id: 'cmt-other',
        arc_id: 'arc-1',
        session_id: 'sess-1',
        message_id: 'msg-OTHER',
        parent_comment_id: null,
        author_user_id: 'u',
        body: 'unrelated',
        created_at: 500,
        modified_at: 500,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
      },
    )
    const ctx = createCtx(sql)
    const res = listCommentsForMessage(ctx, { messageId: 'msg-1' })
    expect(res.comments.map((c) => c.body)).toEqual(['first', 'second', 'third'])
  })

  it('returns an empty array when no comments anchor to the messageId', () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = listCommentsForMessage(ctx, { messageId: 'unknown-msg' })
    expect(res.comments).toEqual([])
  })
})
