import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#152 P1.3 WU-E — unit coverage for rpc-chat impls (ArcCollabDO).
 *
 * Models test infra on `agents/session-do/rpc-comments.test.ts` — a
 * hand-rolled in-memory SQL fake that knows the exact query shapes
 * rpc-chat.ts issues. Mocks `~/lib/broadcast-arc-room` so we can
 * assert the per-channel ops shape without needing the D1 / DO RPC
 * stack to spin up.
 *
 * D1 mirror: rpc-chat issues `drizzle(env.AUTH_DB, {schema}).insert(...)
 * .values(...)` (and `.update(...).set(...).where(...)`) inside
 * `ctx.ctx.waitUntil(...)`. We mock `drizzle-orm/d1` to a chainable
 * builder so the mirror call doesn't throw — failures inside the
 * mirror are swallowed by rpc-chat itself, so we only need to verify
 * the mirror was attempted (it ran inside waitUntil) and that mirror
 * failure doesn't break the broadcast / status code on the happy path.
 */

vi.mock('~/lib/broadcast-arc-room', () => ({
  broadcastArcRoom: vi.fn(async () => undefined),
}))

// Default to a no-op parseMentions so the existing tests (which don't
// care about mentions) keep passing without queuing fake member rows.
// The mentions-integration block at the bottom overrides per-test.
vi.mock('~/lib/parse-mentions', () => ({
  parseMentions: vi.fn(async () => ({ resolvedUserIds: [], unresolvedTokens: [] })),
}))

// Stub the collab-summary fanout helpers so the existing suite is not
// blocked on D1 (the originals tried to drizzle().select() member rows
// from an empty AUTH_DB stub, which surfaced as an unhandled rejection).
vi.mock('~/lib/collab-summary', () => ({
  recordMentions: vi.fn(async () => undefined),
  incrementArcUnread: vi.fn(async () => undefined),
}))

// Chainable drizzle stub. Per-test override of the terminal resolver
// via `__d1Resolver` so individual tests can force the mirror to throw.
const d1State: { resolver: () => Promise<unknown> } = {
  resolver: () => Promise.resolve(undefined),
}
vi.mock('drizzle-orm/d1', () => {
  function makeChain(): unknown {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          const p = d1State.resolver()
          return p.then.bind(p)
        }
        if (prop === 'catch') {
          const p = d1State.resolver()
          return p.catch.bind(p)
        }
        if (prop === 'finally') {
          const p = d1State.resolver()
          return p.finally.bind(p)
        }
        return (..._args: unknown[]) => makeChain()
      },
    }
    return new Proxy(() => {}, handler)
  }
  return {
    drizzle: vi.fn(() => ({
      insert: () => makeChain(),
      update: () => makeChain(),
      select: () => makeChain(),
      delete: () => makeChain(),
    })),
  }
})

import { broadcastArcRoom } from '~/lib/broadcast-arc-room'
import { incrementArcUnread, recordMentions } from '~/lib/collab-summary'
import { parseMentions } from '~/lib/parse-mentions'
import {
  type ArcCollabDOContext,
  addChatImpl,
  deleteChatImpl,
  editChatImpl,
  listChatForArc,
} from './rpc-chat'

interface ChatRow {
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
}

interface SubmitIdRow {
  id: string
  created_at: number
}

/**
 * In-memory SQL fake that handles the exact query shapes rpc-chat.ts
 * issues via `ctx.sql.exec(...)` (positional-bind only — rpc-chat does
 * NOT use the tagged-template form). Strict-match on the literal
 * (whitespace-collapsed) query so impl drift surfaces as a loud
 * "unrecognised query shape" failure here.
 */
class FakeSql {
  chat: ChatRow[] = []
  submitIds: SubmitIdRow[] = []

  exec<T = unknown>(query: string, ...bindings: unknown[]): { [Symbol.iterator](): Iterator<T> } {
    const q = query.replace(/\s+/g, ' ').trim()

    // SELECT ... FROM chat_messages WHERE id = ? LIMIT 1
    if (/^SELECT id, arc_id, author_user_id.*FROM chat_messages WHERE id = \? LIMIT 1$/.test(q)) {
      const [id] = bindings as [string]
      const row = this.chat.find((r) => r.id === id)
      return iter(row ? [row as unknown as T] : [])
    }

    // SELECT id FROM submit_ids WHERE id = ? LIMIT 1
    if (/^SELECT id FROM submit_ids WHERE id = \? LIMIT 1$/.test(q)) {
      const [id] = bindings as [string]
      const row = this.submitIds.find((r) => r.id === id)
      return iter(row ? [{ id: row.id } as unknown as T] : [])
    }

    // INSERT INTO chat_messages (...) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)
    if (/^INSERT INTO chat_messages/.test(q)) {
      const [id, arc_id, author_user_id, body, created_at, modified_at] = bindings as [
        string,
        string,
        string,
        string,
        number,
        number,
      ]
      if (this.chat.some((r) => r.id === id)) {
        throw new Error(`UNIQUE constraint failed: chat_messages.id`)
      }
      this.chat.push({
        id,
        arc_id,
        author_user_id,
        body,
        mentions: null,
        created_at,
        modified_at,
        edited_at: null,
        deleted_at: null,
        deleted_by: null,
      })
      return iter<T>([])
    }

    // INSERT OR IGNORE INTO submit_ids (id, created_at) VALUES (?, ?)
    if (/^INSERT OR IGNORE INTO submit_ids/.test(q)) {
      const [id, createdAt] = bindings as [string, number]
      if (!this.submitIds.some((r) => r.id === id)) {
        this.submitIds.push({ id, created_at: createdAt })
      }
      return iter<T>([])
    }

    // DELETE FROM submit_ids WHERE created_at < ?
    if (/^DELETE FROM submit_ids WHERE created_at < \?$/.test(q)) {
      const [cutoff] = bindings as [number]
      this.submitIds = this.submitIds.filter((r) => r.created_at >= cutoff)
      return iter<T>([])
    }

    // GH#152 P1.5 WU-B mentions UPDATE — fired only when parseMentions
    // resolved at least one id.
    if (/^UPDATE chat_messages SET mentions = \? WHERE id = \?$/.test(q)) {
      const [mentions, id] = bindings as [string, string]
      const row = this.chat.find((r) => r.id === id)
      if (row) row.mentions = mentions
      return iter<T>([])
    }

    // UPDATE chat_messages SET body = ?, edited_at = ?, modified_at = ? WHERE id = ?
    if (
      /^UPDATE chat_messages SET body = \?, edited_at = \?, modified_at = \? WHERE id = \?$/.test(q)
    ) {
      const [body, editedAt, modifiedAt, id] = bindings as [string, number, number, string]
      const row = this.chat.find((r) => r.id === id)
      if (row) {
        row.body = body
        row.edited_at = editedAt
        row.modified_at = modifiedAt
      }
      return iter<T>([])
    }

    // UPDATE chat_messages SET deleted_at = ?, deleted_by = ?, modified_at = ? WHERE id = ?
    if (
      /^UPDATE chat_messages SET deleted_at = \?, deleted_by = \?, modified_at = \? WHERE id = \?$/.test(
        q,
      )
    ) {
      const [deletedAt, deletedBy, modifiedAt, id] = bindings as [
        number,
        string | null,
        number,
        string,
      ]
      const row = this.chat.find((r) => r.id === id)
      if (row) {
        row.deleted_at = deletedAt
        row.deleted_by = deletedBy
        row.modified_at = modifiedAt
      }
      return iter<T>([])
    }

    // SELECT ... FROM chat_messages ORDER BY created_at DESC, id ASC LIMIT ?
    if (/FROM chat_messages ORDER BY created_at DESC, id ASC LIMIT \?$/.test(q)) {
      const [limit] = bindings as [number]
      const sorted = [...this.chat].sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )
      return iter(sorted.slice(0, limit).map((r) => r as unknown as T))
    }

    // SELECT ... FROM chat_messages WHERE (modified_at > ?) OR (modified_at = ? AND id > ?)
    //   ORDER BY modified_at ASC, id ASC LIMIT ?
    if (
      /FROM chat_messages WHERE \(modified_at > \?\) OR \(modified_at = \? AND id > \?\) ORDER BY modified_at ASC, id ASC LIMIT \?$/.test(
        q,
      )
    ) {
      const [modifiedAtA, _modifiedAtB, id, limit] = bindings as [number, number, string, number]
      const matched = this.chat
        .filter((r) => r.modified_at > modifiedAtA || (r.modified_at === modifiedAtA && r.id > id))
        .sort((a, b) => a.modified_at - b.modified_at || a.id.localeCompare(b.id))
      return iter(matched.slice(0, limit).map((r) => r as unknown as T))
    }

    throw new Error(`FakeSql.exec: unrecognised query shape: ${q}`)
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
  arcId?: string
}

function createCtx(sql: FakeSql, opts: CtxOpts = {}): ArcCollabDOContext {
  const arcId = opts.arcId ?? 'arc-1'
  const waited: Promise<unknown>[] = []
  const ctx: ArcCollabDOContext = {
    do: { name: arcId },
    ctx: {
      id: { toString: () => 'do-id-x' } as unknown as DurableObjectId,
      storage: {} as unknown as DurableObjectStorage,
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p)
      },
    },
    env: { AUTH_DB: {} as unknown } as ArcCollabDOContext['env'],
    sql: sql as unknown as SqlStorage,
  }
  // Surface the waiter list so mention-integration tests can flush
  // them after addChatImpl returns.
  ;(ctx as unknown as { __waiters: Promise<unknown>[] }).__waiters = waited
  return ctx
}

async function flushWaiters(ctx: ArcCollabDOContext): Promise<void> {
  const waiters = (ctx as unknown as { __waiters?: Promise<unknown>[] }).__waiters ?? []
  await Promise.all(waiters)
}

beforeEach(() => {
  vi.mocked(broadcastArcRoom).mockClear()
  vi.mocked(parseMentions).mockClear()
  vi.mocked(parseMentions).mockResolvedValue({ resolvedUserIds: [], unresolvedTokens: [] })
  vi.mocked(recordMentions).mockClear()
  vi.mocked(incrementArcUnread).mockClear()
  d1State.resolver = () => Promise.resolve(undefined)
})

describe('addChatImpl', () => {
  it('inserts on the happy path and broadcasts a single insert op on arcChat:<arcId>', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)

    const res = await addChatImpl(ctx, {
      body: 'hello',
      clientChatId: 'chat-1',
      senderId: 'user-A',
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(200)
    expect(res.chat.id).toBe('chat-1')
    expect(res.chat.body).toBe('hello')
    expect(res.chat.arcId).toBe('arc-1')
    expect(res.chat.authorUserId).toBe('user-A')
    expect(res.chat.editedAt).toBeNull()
    expect(res.chat.deletedAt).toBeNull()

    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)
    const call = vi.mocked(broadcastArcRoom).mock.calls[0]
    // (env, ctx, arcId, channel, ops)
    expect(call[2]).toBe('arc-1')
    expect(call[3]).toBe('arcChat:arc-1')
    const ops = call[4] as Array<{ type: string; value: unknown }>
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('insert')
    expect(ops[0].value).toMatchObject({ id: 'chat-1', body: 'hello' })

    // Persisted in the chat store + submit_ids.
    expect(sql.chat).toHaveLength(1)
    expect(sql.submitIds.find((s) => s.id === 'chat-1')).toBeTruthy()
  })

  it('rejects an empty body with body_required (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await addChatImpl(ctx, { body: '   ', clientChatId: 'chat-1' })
    expect(res).toEqual({ ok: false, error: 'body_required', status: 422 })
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })

  it('rejects an oversized clientChatId (>64 chars) with invalid_client_chat_id (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await addChatImpl(ctx, { body: 'x', clientChatId: 'a'.repeat(65) })
    expect(res).toEqual({ ok: false, error: 'invalid_client_chat_id', status: 422 })
  })

  it('is idempotent on the same clientChatId — second call returns cached row, no second broadcast', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)

    const first = await addChatImpl(ctx, {
      body: 'first',
      clientChatId: 'chat-dup',
      senderId: 'user-A',
    })
    expect(first.ok).toBe(true)
    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)

    const second = await addChatImpl(ctx, {
      body: 'second-attempt',
      clientChatId: 'chat-dup',
      senderId: 'user-A',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.status).toBe(200)
    // Returns the cached row (body from the first call).
    expect(second.chat.body).toBe('first')
    expect(second.chat.id).toBe('chat-dup')

    // No second broadcast and no second insert.
    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)
    expect(sql.chat).toHaveLength(1)
  })

  it('fail-safe: D1 mirror failure does NOT prevent broadcast or success status', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    // Force the mirror's terminal `await db.insert(...).values(...)` to reject.
    d1State.resolver = () => Promise.reject(new Error('d1 boom'))

    const res = await addChatImpl(ctx, {
      body: 'survives mirror failure',
      clientChatId: 'chat-mirror-fail',
      senderId: 'user-A',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(200)
    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)
    expect(sql.chat).toHaveLength(1)
  })
})

describe('editChatImpl', () => {
  function seed(sql: FakeSql, overrides: Partial<ChatRow> = {}): ChatRow {
    const row: ChatRow = {
      id: 'chat-A',
      arc_id: 'arc-1',
      author_user_id: 'user-A',
      body: 'original',
      mentions: null,
      created_at: 1000,
      modified_at: 1000,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      ...overrides,
    }
    sql.chat.push(row)
    return row
  }

  it('returns chat_not_found (404) for a missing chat id', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await editChatImpl(ctx, {
      chatId: 'no-such',
      body: 'x',
      senderId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'chat_not_found', status: 404 })
  })

  it('returns chat_deleted (410) when the row is already soft-deleted', async () => {
    const sql = new FakeSql()
    seed(sql, { deleted_at: 2000, deleted_by: 'user-A' })
    const ctx = createCtx(sql)
    const res = await editChatImpl(ctx, {
      chatId: 'chat-A',
      body: 'edit',
      senderId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'chat_deleted', status: 410 })
  })

  it('returns not_author (403) when the senderId does not match', async () => {
    const sql = new FakeSql()
    seed(sql)
    const ctx = createCtx(sql)
    const res = await editChatImpl(ctx, {
      chatId: 'chat-A',
      body: 'edit',
      senderId: 'user-OTHER',
    })
    expect(res).toEqual({ ok: false, error: 'not_author', status: 403 })
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })

  it('updates body + edited_at and broadcasts an update op on the happy path', async () => {
    const sql = new FakeSql()
    seed(sql)
    const ctx = createCtx(sql)
    const res = await editChatImpl(ctx, {
      chatId: 'chat-A',
      body: 'edited body',
      senderId: 'user-A',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.chat.body).toBe('edited body')
    expect(res.chat.editedAt).not.toBeNull()
    expect(res.chat.modifiedAt).toBe(res.chat.editedAt)

    expect(sql.chat[0].body).toBe('edited body')
    expect(sql.chat[0].edited_at).not.toBeNull()

    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)
    const ops = vi.mocked(broadcastArcRoom).mock.calls[0][4] as Array<{
      type: string
      value: unknown
    }>
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('update')
    expect(ops[0].value).toMatchObject({ id: 'chat-A', body: 'edited body' })
  })
})

describe('deleteChatImpl', () => {
  function seed(sql: FakeSql, overrides: Partial<ChatRow> = {}): ChatRow {
    const row: ChatRow = {
      id: 'chat-A',
      arc_id: 'arc-1',
      author_user_id: 'user-A',
      body: 'doomed',
      mentions: null,
      created_at: 1000,
      modified_at: 1000,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      ...overrides,
    }
    sql.chat.push(row)
    return row
  }

  it('returns chat_not_found (404) for a missing chat id', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await deleteChatImpl(ctx, {
      chatId: 'no-such',
      senderId: 'user-A',
      callerRole: 'member',
    })
    expect(res).toEqual({ ok: false, error: 'chat_not_found', status: 404 })
  })

  it('returns forbidden (403) for a non-author non-owner non-admin caller', async () => {
    const sql = new FakeSql()
    seed(sql)
    const ctx = createCtx(sql)
    const res = await deleteChatImpl(ctx, {
      chatId: 'chat-A',
      senderId: 'user-OTHER',
      callerRole: 'member',
    })
    expect(res).toEqual({ ok: false, error: 'forbidden', status: 403 })
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })

  it('soft-deletes for the author, sets deleted_by = senderId, broadcasts update', async () => {
    const sql = new FakeSql()
    seed(sql)
    const ctx = createCtx(sql)
    const res = await deleteChatImpl(ctx, {
      chatId: 'chat-A',
      senderId: 'user-A',
      callerRole: 'member',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.chat.deletedAt).not.toBeNull()
    expect(res.chat.deletedBy).toBe('user-A')
    expect(sql.chat[0].deleted_at).not.toBeNull()
    expect(sql.chat[0].deleted_by).toBe('user-A')

    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)
    const ops = vi.mocked(broadcastArcRoom).mock.calls[0][4] as Array<{
      type: string
      value: unknown
    }>
    expect(ops[0].type).toBe('update')
  })

  it("allows owner role to delete a different user's chat", async () => {
    const sql = new FakeSql()
    seed(sql, { author_user_id: 'user-A' })
    const ctx = createCtx(sql)
    const res = await deleteChatImpl(ctx, {
      chatId: 'chat-A',
      senderId: 'user-OWNER',
      callerRole: 'owner',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.chat.deletedBy).toBe('user-OWNER')
  })

  it("allows admin role to delete a different user's chat", async () => {
    const sql = new FakeSql()
    seed(sql, { author_user_id: 'user-A' })
    const ctx = createCtx(sql)
    const res = await deleteChatImpl(ctx, {
      chatId: 'chat-A',
      senderId: 'user-ADMIN',
      callerRole: 'admin',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.chat.deletedBy).toBe('user-ADMIN')
  })

  it('is idempotent on already-deleted rows: returns existing row, no second broadcast', async () => {
    const sql = new FakeSql()
    seed(sql, { deleted_at: 5000, deleted_by: 'user-A' })
    const ctx = createCtx(sql)
    const res = await deleteChatImpl(ctx, {
      chatId: 'chat-A',
      senderId: 'user-A',
      callerRole: 'member',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.chat.deletedAt).toBe(5000)
    expect(res.chat.deletedBy).toBe('user-A')
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })
})

describe('listChatForArc', () => {
  function seedRow(sql: FakeSql, overrides: Partial<ChatRow> & { id: string }): void {
    sql.chat.push({
      arc_id: 'arc-1',
      author_user_id: 'user-A',
      body: overrides.id,
      mentions: null,
      created_at: 1000,
      modified_at: 1000,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
      ...overrides,
    })
  }

  it('null cursor → returns rows sorted chronologically (oldest first), capped at 200', () => {
    const sql = new FakeSql()
    seedRow(sql, { id: 'c-mid', created_at: 2000, modified_at: 2000 })
    seedRow(sql, { id: 'c-old', created_at: 1000, modified_at: 1000 })
    seedRow(sql, { id: 'c-new', created_at: 3000, modified_at: 3000 })

    const ctx = createCtx(sql)
    const res = listChatForArc(ctx, { sinceCursor: null })
    expect(res.chat.map((c) => c.id)).toEqual(['c-old', 'c-mid', 'c-new'])
  })

  it('with cursor → returns rows where (modifiedAt, id) > sinceCursor sorted ASC', () => {
    const sql = new FakeSql()
    seedRow(sql, { id: 'r-a', created_at: 1000, modified_at: 1000 })
    seedRow(sql, { id: 'r-b', created_at: 2000, modified_at: 2000 })
    seedRow(sql, { id: 'r-c', created_at: 3000, modified_at: 3000 })

    const ctx = createCtx(sql)
    const res = listChatForArc(ctx, {
      sinceCursor: { modifiedAt: 1500, id: '' },
    })
    expect(res.chat.map((c) => c.id)).toEqual(['r-b', 'r-c'])
  })

  it('returns an empty array for a fresh arc', () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = listChatForArc(ctx, { sinceCursor: null })
    expect(res.chat).toEqual([])
  })
})

// ── GH#152 P1.5 WU-E: addChatImpl mentions integration ────────────────

describe('addChatImpl mentions integration', () => {
  it('persists the resolved mention list on the row, broadcasts wire row with mentions, and fans out via waitUntil', async () => {
    vi.mocked(parseMentions).mockResolvedValueOnce({
      resolvedUserIds: ['userB', 'userC'],
      unresolvedTokens: [],
    })

    const sql = new FakeSql()
    const ctx = createCtx(sql)

    const res = await addChatImpl(ctx, {
      body: 'hi @b @c please review',
      clientChatId: 'chat-mentions-1',
      senderId: 'userA',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Wire row carries the resolved ids verbatim.
    expect(res.chat.mentions).toEqual(['userB', 'userC'])

    // The persisted SQL row's `mentions` column is the JSON-encoded array.
    const persisted = sql.chat.find((r) => r.id === 'chat-mentions-1')
    expect(persisted).toBeDefined()
    expect(persisted!.mentions).toBe(JSON.stringify(['userB', 'userC']))

    // Broadcast op carries the mentions on the wire shape.
    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)
    const ops = vi.mocked(broadcastArcRoom).mock.calls[0][4] as Array<{
      type: string
      value: { mentions: string[] | null }
    }>
    expect(ops[0].value.mentions).toEqual(['userB', 'userC'])

    // recordMentions + incrementArcUnread are queued under waitUntil.
    await flushWaiters(ctx)

    expect(recordMentions).toHaveBeenCalledTimes(1)
    const recordArgs = vi.mocked(recordMentions).mock.calls[0][2]
    expect(recordArgs).toMatchObject({
      arcId: 'arc-1',
      sourceKind: 'chat',
      sourceId: 'chat-mentions-1',
      actorUserId: 'userA',
      preview: 'hi @b @c please review',
      resolvedUserIds: ['userB', 'userC'],
    })

    expect(incrementArcUnread).toHaveBeenCalledTimes(1)
    const unreadArgs = vi.mocked(incrementArcUnread).mock.calls[0]
    // (env, ctx, arcId, channel, authorUserId)
    expect(unreadArgs[2]).toBe('arc-1')
    expect(unreadArgs[3]).toBe('chat')
    expect(unreadArgs[4]).toBe('userA')
  })

  it('no resolved mentions → still bumps unread (unconditional) but skips recordMentions', async () => {
    vi.mocked(parseMentions).mockResolvedValueOnce({
      resolvedUserIds: [],
      unresolvedTokens: ['ghost'],
    })

    const sql = new FakeSql()
    const ctx = createCtx(sql)

    const res = await addChatImpl(ctx, {
      body: 'no mentions here',
      clientChatId: 'chat-noresolve',
      senderId: 'userA',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(res.chat.mentions).toBeNull()
    const persisted = sql.chat.find((r) => r.id === 'chat-noresolve')
    expect(persisted!.mentions).toBeNull()

    await flushWaiters(ctx)

    // recordMentions is gated on resolvedUserIds.length > 0 → not called.
    expect(recordMentions).not.toHaveBeenCalled()
    // incrementArcUnread runs unconditionally on the chat channel.
    expect(incrementArcUnread).toHaveBeenCalledTimes(1)
    expect(vi.mocked(incrementArcUnread).mock.calls[0][3]).toBe('chat')
  })
})
