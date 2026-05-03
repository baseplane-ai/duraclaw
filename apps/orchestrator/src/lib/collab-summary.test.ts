/**
 * GH#152 P1.5 WU-E — coverage for `incrementArcUnread` + `recordMentions`.
 *
 * Both helpers are split along the same lines: load some context from
 * D1, write rows back, then `ctx.waitUntil` per-user broadcasts via
 * `broadcastSyncedDelta`. We mock the broadcaster (it's already covered
 * by `broadcast-arc-room.test.ts` + `db/synced-collection.test.ts`) and
 * stand up just enough of `env.AUTH_DB` / `drizzle()` for the helpers
 * to walk through.
 *
 *   - `incrementArcUnread` calls `drizzle(env.AUTH_DB).select().from(arc_members)
 *     .where(...)` once per write to load member ids, then issues a
 *     prepare/bind/run upsert + a prepare/bind/first re-read per
 *     non-author target. We mock both surfaces.
 *   - `recordMentions` writes a row per resolved user via prepare/bind/run.
 *
 * Both run their broadcasts under `ctx.waitUntil`; the test ctx
 * collects those promises and awaits them so the mocks see the calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./broadcast-synced-delta', () => ({
  broadcastSyncedDelta: vi.fn(async () => undefined),
}))

// drizzle() is only used by incrementArcUnread to load arc members.
const drizzleState: { members: Array<{ userId: string }> | Error } = { members: [] }
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => {
          if (drizzleState.members instanceof Error) {
            return Promise.reject(drizzleState.members)
          }
          return Promise.resolve(drizzleState.members)
        },
      }),
    }),
  })),
}))

import { broadcastSyncedDelta } from './broadcast-synced-delta'
import { incrementArcUnread, recordMentions } from './collab-summary'
import type { Env } from './types'

// ── Fake env.AUTH_DB ──────────────────────────────────────────────────
//
// The helpers use `env.AUTH_DB.prepare(sql).bind(...args).run()` and
// `.first<T>()`. We capture every `.bind(...)` invocation per-prepare so
// tests can assert call shape, and let each test optionally override the
// `first()` result for the re-read path.

interface PreparedCall {
  sql: string
  bindings: unknown[]
}

interface FakeAuthDb {
  calls: PreparedCall[]
  /** Return value for the next prepare(...).bind(...).first<>() call. */
  firstResult: () => Record<string, unknown> | null
  /** Whether prepare(...).bind(...).run() should reject. */
  runShouldThrow: boolean
}

function makeFakeAuthDb(): FakeAuthDb {
  return {
    calls: [],
    firstResult: () => ({ unreadComments: 1, unreadChat: 0 }),
    runShouldThrow: false,
  }
}

function makeEnv(authDb: FakeAuthDb): Env {
  const prepare = (sql: string) => {
    return {
      bind: (...bindings: unknown[]) => {
        authDb.calls.push({ sql, bindings })
        return {
          run: async () => {
            if (authDb.runShouldThrow) throw new Error('prepare/run boom')
            return { success: true }
          },
          first: async <T>() => authDb.firstResult() as T,
        }
      },
    }
  }
  return {
    AUTH_DB: { prepare },
    SYNC_BROADCAST_SECRET: 'test-secret',
  } as unknown as Env
}

interface FakeCtx {
  waitUntil: (p: Promise<unknown>) => void
  /** Promises queued via waitUntil — `flush()`-able. */
  waiters: Promise<unknown>[]
}

function makeCtx(): FakeCtx {
  const waiters: Promise<unknown>[] = []
  return {
    waitUntil: (p: Promise<unknown>) => {
      waiters.push(p)
    },
    waiters,
  }
}

async function flush(ctx: FakeCtx): Promise<void> {
  // Helpers fan out via waitUntil; await all queued promises so the
  // broadcast-synced-delta calls are observable.
  await Promise.all(ctx.waiters)
}

beforeEach(() => {
  vi.mocked(broadcastSyncedDelta).mockClear()
  drizzleState.members = []
})

describe('incrementArcUnread', () => {
  it('with channel=comments + 3 members (A=author, B, C): upserts twice (B, C) and broadcasts twice on arcUnread', async () => {
    drizzleState.members = [{ userId: 'A' }, { userId: 'B' }, { userId: 'C' }]
    const db = makeFakeAuthDb()
    // The re-read returns whatever counters we want per call; alternate
    // so each broadcast carries its target's value.
    let i = 0
    const reads = [
      { unreadComments: 1, unreadChat: 0 },
      { unreadComments: 1, unreadChat: 0 },
    ]
    db.firstResult = () => reads[i++ % reads.length]
    const env = makeEnv(db)
    const ctx = makeCtx()

    await incrementArcUnread(env, ctx, 'arc-1', 'comments', 'A')
    await flush(ctx)

    // The author (A) is filtered out, so only B + C see writes — each
    // gets one upsert (the INSERT/UPSERT) followed by a re-read SELECT.
    // 2 targets × 2 prepared statements = 4 .bind() calls.
    expect(db.calls).toHaveLength(4)
    expect(db.calls[0].bindings).toEqual(['B', 'arc-1'])
    expect(db.calls[1].bindings).toEqual(['B', 'arc-1'])
    expect(db.calls[2].bindings).toEqual(['C', 'arc-1'])
    expect(db.calls[3].bindings).toEqual(['C', 'arc-1'])
    // The upsert SQL bumps unread_comments (channel='comments').
    expect(db.calls[0].sql).toMatch(/SET unread_comments = unread_comments \+ 1/)

    // 2 broadcasts, one per target on the `arcUnread` collection.
    expect(broadcastSyncedDelta).toHaveBeenCalledTimes(2)
    const targets = vi.mocked(broadcastSyncedDelta).mock.calls.map((c) => c[1])
    expect(targets.sort()).toEqual(['B', 'C'])
    for (const call of vi.mocked(broadcastSyncedDelta).mock.calls) {
      expect(call[2]).toBe('arcUnread')
      const ops = call[3] as Array<{ type: string; value: Record<string, unknown> }>
      expect(ops).toHaveLength(1)
      expect(ops[0].type).toBe('update')
      const userId = call[1]
      expect(ops[0].value).toMatchObject({
        id: `${userId}:arc-1`,
        userId,
        arcId: 'arc-1',
        unreadComments: 1,
        unreadChat: 0,
      })
    }
  })

  it('channel=chat flips the upsert to bump unread_chat instead', async () => {
    drizzleState.members = [{ userId: 'A' }, { userId: 'B' }]
    const db = makeFakeAuthDb()
    db.firstResult = () => ({ unreadComments: 0, unreadChat: 7 })
    const env = makeEnv(db)
    const ctx = makeCtx()

    await incrementArcUnread(env, ctx, 'arc-1', 'chat', 'A')
    await flush(ctx)

    // Just one non-author target (B): one upsert + one re-read.
    expect(db.calls).toHaveLength(2)
    expect(db.calls[0].sql).toMatch(/SET unread_chat = unread_chat \+ 1/)
    expect(db.calls[0].sql).not.toMatch(/SET unread_comments/)

    expect(broadcastSyncedDelta).toHaveBeenCalledTimes(1)
    const op = (
      vi.mocked(broadcastSyncedDelta).mock.calls[0][3] as Array<{
        value: Record<string, unknown>
      }>
    )[0]
    expect(op.value).toMatchObject({
      id: 'B:arc-1',
      userId: 'B',
      arcId: 'arc-1',
      unreadComments: 0,
      unreadChat: 7,
    })
  })

  it('empty member list → no DB calls, no broadcasts', async () => {
    drizzleState.members = []
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    await incrementArcUnread(env, ctx, 'arc-1', 'comments', 'A')
    await flush(ctx)

    expect(db.calls).toHaveLength(0)
    expect(broadcastSyncedDelta).not.toHaveBeenCalled()
  })

  it('all-author membership (only the author is a member) → no upserts, no broadcasts', async () => {
    drizzleState.members = [{ userId: 'A' }]
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    await incrementArcUnread(env, ctx, 'arc-1', 'comments', 'A')
    await flush(ctx)

    expect(db.calls).toHaveLength(0)
    expect(broadcastSyncedDelta).not.toHaveBeenCalled()
  })

  it('member-load failure short-circuits without broadcasting', async () => {
    drizzleState.members = new Error('d1 down')
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    await incrementArcUnread(env, ctx, 'arc-1', 'comments', 'A')
    await flush(ctx)

    expect(db.calls).toHaveLength(0)
    expect(broadcastSyncedDelta).not.toHaveBeenCalled()
  })
})

describe('recordMentions', () => {
  it('inserts one arc_mentions row per resolved target (filtering the actor) and broadcasts on arcMentions', async () => {
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    await recordMentions(env, ctx, {
      arcId: 'arc-1',
      sourceKind: 'comment',
      sourceId: 'cmt-1',
      actorUserId: 'A',
      preview: 'hello @bob and @carol',
      // Actor A appears in the resolved list (defensive); the helper
      // filters them out.
      resolvedUserIds: ['A', 'B', 'C'],
    })
    await flush(ctx)

    // 2 inserts (B + C); A is filtered as the actor.
    expect(db.calls).toHaveLength(2)
    for (const call of db.calls) {
      expect(call.sql).toMatch(/INSERT INTO arc_mentions/)
      // Bindings: [id, userId, arcId, sourceKind, sourceId, actorUserId,
      //   preview, mentionTs] — 8 placeholders, then NULL for read_at.
      expect(call.bindings).toHaveLength(8)
      const [, userId, arcId, sourceKind, sourceId, actorUserId, preview, mentionTs] =
        call.bindings as [string, string, string, string, string, string, string, string]
      expect(arcId).toBe('arc-1')
      expect(sourceKind).toBe('comment')
      expect(sourceId).toBe('cmt-1')
      expect(actorUserId).toBe('A')
      expect(preview).toBe('hello @bob and @carol')
      // ISO 8601 timestamp.
      expect(mentionTs).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(['B', 'C']).toContain(userId)
    }

    // 2 broadcasts on `arcMentions` (one per target).
    expect(broadcastSyncedDelta).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(broadcastSyncedDelta).mock.calls) {
      expect(call[2]).toBe('arcMentions')
      const ops = call[3] as Array<{ type: string; value: Record<string, unknown> }>
      expect(ops).toHaveLength(1)
      expect(ops[0].type).toBe('insert')
      // The wire row mirrors the inserted row, plus read_at: null.
      expect(ops[0].value).toMatchObject({
        userId: call[1],
        arcId: 'arc-1',
        sourceKind: 'comment',
        sourceId: 'cmt-1',
        actorUserId: 'A',
        preview: 'hello @bob and @carol',
        readAt: null,
      })
    }
  })

  it('truncates preview at 160 chars before persisting + broadcasting', async () => {
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    const longPreview = 'x'.repeat(200)
    await recordMentions(env, ctx, {
      arcId: 'arc-1',
      sourceKind: 'chat',
      sourceId: 'chat-1',
      actorUserId: 'A',
      preview: longPreview,
      resolvedUserIds: ['B'],
    })
    await flush(ctx)

    expect(db.calls).toHaveLength(1)
    const preview = (db.calls[0].bindings as string[])[6]
    expect(preview).toHaveLength(160)
    expect(preview).toBe('x'.repeat(160))

    expect(broadcastSyncedDelta).toHaveBeenCalledTimes(1)
    const op = (
      vi.mocked(broadcastSyncedDelta).mock.calls[0][3] as Array<{
        value: Record<string, unknown>
      }>
    )[0]
    expect(op.value.preview).toBe('x'.repeat(160))
  })

  it('empty resolvedUserIds → no DB calls, no broadcasts', async () => {
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    await recordMentions(env, ctx, {
      arcId: 'arc-1',
      sourceKind: 'comment',
      sourceId: 'cmt-1',
      actorUserId: 'A',
      preview: 'hi',
      resolvedUserIds: [],
    })
    await flush(ctx)

    expect(db.calls).toHaveLength(0)
    expect(broadcastSyncedDelta).not.toHaveBeenCalled()
  })

  it('resolved list of only the actor → filtered to empty → no writes', async () => {
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    await recordMentions(env, ctx, {
      arcId: 'arc-1',
      sourceKind: 'chat',
      sourceId: 'chat-1',
      actorUserId: 'A',
      preview: 'hi',
      resolvedUserIds: ['A'],
    })
    await flush(ctx)

    expect(db.calls).toHaveLength(0)
    expect(broadcastSyncedDelta).not.toHaveBeenCalled()
  })

  it('each broadcast row has read_at=null and an ISO mentionTs', async () => {
    const db = makeFakeAuthDb()
    const env = makeEnv(db)
    const ctx = makeCtx()

    await recordMentions(env, ctx, {
      arcId: 'arc-2',
      sourceKind: 'comment',
      sourceId: 'cmt-7',
      actorUserId: 'X',
      preview: 'pinging @y',
      resolvedUserIds: ['Y'],
    })
    await flush(ctx)

    expect(broadcastSyncedDelta).toHaveBeenCalledTimes(1)
    const op = (
      vi.mocked(broadcastSyncedDelta).mock.calls[0][3] as Array<{
        value: Record<string, unknown>
      }>
    )[0]
    expect(op.value.readAt).toBeNull()
    expect(typeof op.value.mentionTs).toBe('string')
    expect(op.value.mentionTs as string).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(op.value.actorUserId).toBe('X')
  })
})
