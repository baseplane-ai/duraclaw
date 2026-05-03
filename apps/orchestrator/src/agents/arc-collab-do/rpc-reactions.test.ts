import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#152 P1.4 B12 — unit coverage for rpc-reactions impls (ArcCollabDO).
 *
 * Models test infra on `rpc-chat.test.ts` — a hand-rolled in-memory SQL
 * fake matching the exact query shapes `toggleReactionImpl` /
 * `listReactionsForArc` issue. Mocks `~/lib/broadcast-arc-room` so we
 * can assert per-channel ops shape without spinning up the D1 / DO RPC
 * stack.
 *
 * Reactions have no D1 mirror (per rpc-reactions.ts header), so unlike
 * rpc-chat.test.ts we don't need a `drizzle-orm/d1` chainable stub.
 */

vi.mock('~/lib/broadcast-arc-room', () => ({
  broadcastArcRoom: vi.fn(async () => undefined),
}))

import { broadcastArcRoom } from '~/lib/broadcast-arc-room'
import type { ArcCollabDOContext } from './rpc-chat'
import { listReactionsForArc, toggleReactionImpl } from './rpc-reactions'

interface ReactionRowSql {
  target_kind: string
  target_id: string
  user_id: string
  emoji: string
  created_at: number
}

/**
 * Strict-match in-memory SQL fake — matches the literal
 * (whitespace-collapsed) query so impl drift surfaces as a loud
 * "unrecognised query shape" failure.
 */
class FakeSql {
  reactions: ReactionRowSql[] = []

  exec<T = unknown>(query: string, ...bindings: unknown[]): { [Symbol.iterator](): Iterator<T> } {
    const q = query.replace(/\s+/g, ' ').trim()

    // SELECT target_kind, target_id, user_id, emoji, created_at
    //   FROM reactions
    //   WHERE target_kind = ? AND target_id = ? AND user_id = ? AND emoji = ?
    //   LIMIT 1
    if (
      /^SELECT target_kind, target_id, user_id, emoji, created_at FROM reactions WHERE target_kind = \? AND target_id = \? AND user_id = \? AND emoji = \? LIMIT 1$/.test(
        q,
      )
    ) {
      const [tk, tid, uid, em] = bindings as [string, string, string, string]
      const row = this.reactions.find(
        (r) => r.target_kind === tk && r.target_id === tid && r.user_id === uid && r.emoji === em,
      )
      return iter(row ? [row as unknown as T] : [])
    }

    // DELETE FROM reactions
    //   WHERE target_kind = ? AND target_id = ? AND user_id = ? AND emoji = ?
    if (
      /^DELETE FROM reactions WHERE target_kind = \? AND target_id = \? AND user_id = \? AND emoji = \?$/.test(
        q,
      )
    ) {
      const [tk, tid, uid, em] = bindings as [string, string, string, string]
      this.reactions = this.reactions.filter(
        (r) =>
          !(r.target_kind === tk && r.target_id === tid && r.user_id === uid && r.emoji === em),
      )
      return iter<T>([])
    }

    // INSERT INTO reactions (target_kind, target_id, user_id, emoji, created_at)
    //   VALUES (?, ?, ?, ?, ?)
    if (
      /^INSERT INTO reactions \(target_kind, target_id, user_id, emoji, created_at\) VALUES \(\?, \?, \?, \?, \?\)$/.test(
        q,
      )
    ) {
      const [tk, tid, uid, em, ts] = bindings as [string, string, string, string, number]
      // Composite PK enforcement (matches DO SQLite UNIQUE).
      if (
        this.reactions.some(
          (r) => r.target_kind === tk && r.target_id === tid && r.user_id === uid && r.emoji === em,
        )
      ) {
        throw new Error('UNIQUE constraint failed: reactions.(target_kind,target_id,user_id,emoji)')
      }
      this.reactions.push({
        target_kind: tk,
        target_id: tid,
        user_id: uid,
        emoji: em,
        created_at: ts,
      })
      return iter<T>([])
    }

    // SELECT target_kind, target_id, user_id, emoji, created_at
    //   FROM reactions
    //   ORDER BY created_at DESC
    //   LIMIT ?
    if (
      /^SELECT target_kind, target_id, user_id, emoji, created_at FROM reactions ORDER BY created_at DESC LIMIT \?$/.test(
        q,
      )
    ) {
      const [limit] = bindings as [number]
      const sorted = [...this.reactions].sort((a, b) => b.created_at - a.created_at)
      return iter(sorted.slice(0, limit).map((r) => r as unknown as T))
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
  return {
    do: { name: arcId },
    ctx: {
      id: { toString: () => 'do-id-x' } as unknown as DurableObjectId,
      storage: {} as unknown as DurableObjectStorage,
      waitUntil: (_p: Promise<unknown>) => {
        /* no-op for reactions tests; rpc-reactions doesn't waitUntil. */
      },
    },
    env: { AUTH_DB: {} as unknown } as ArcCollabDOContext['env'],
    sql: sql as unknown as SqlStorage,
  }
}

beforeEach(() => {
  vi.mocked(broadcastArcRoom).mockClear()
})

describe('toggleReactionImpl', () => {
  it('first call: INSERT, broadcasts a single insert op, returns action: added', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)

    const res = await toggleReactionImpl(ctx, {
      targetKind: 'comment',
      targetId: 'cmt-1',
      emoji: '👍',
      userId: 'user-A',
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(200)
    expect(res.action).toBe('added')
    expect(res.row.id).toBe('comment:cmt-1:user-A:👍')
    expect(res.row.targetKind).toBe('comment')
    expect(res.row.targetId).toBe('cmt-1')
    expect(res.row.userId).toBe('user-A')
    expect(res.row.emoji).toBe('👍')

    expect(sql.reactions).toHaveLength(1)

    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)
    const call = vi.mocked(broadcastArcRoom).mock.calls[0]
    // (env, ctx, arcId, channel, ops)
    expect(call[2]).toBe('arc-1')
    expect(call[3]).toBe('reactions:arc-1')
    const ops = call[4] as Array<{ type: string; value?: unknown; key?: unknown }>
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('insert')
    expect(ops[0].value).toMatchObject({ id: 'comment:cmt-1:user-A:👍', emoji: '👍' })
  })

  it('second call same composite: DELETE, broadcasts a single delete op, returns action: removed', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)

    const first = await toggleReactionImpl(ctx, {
      targetKind: 'chat',
      targetId: 'chat-1',
      emoji: '❤️',
      userId: 'user-A',
    })
    expect(first.ok).toBe(true)
    expect(sql.reactions).toHaveLength(1)
    expect(broadcastArcRoom).toHaveBeenCalledTimes(1)

    const second = await toggleReactionImpl(ctx, {
      targetKind: 'chat',
      targetId: 'chat-1',
      emoji: '❤️',
      userId: 'user-A',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.action).toBe('removed')
    expect(second.status).toBe(200)
    expect(sql.reactions).toHaveLength(0)

    expect(broadcastArcRoom).toHaveBeenCalledTimes(2)
    const call = vi.mocked(broadcastArcRoom).mock.calls[1]
    expect(call[3]).toBe('reactions:arc-1')
    const ops = call[4] as Array<{ type: string; key?: unknown }>
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('delete')
    expect(ops[0].key).toBe('chat:chat-1:user-A:❤️')
  })

  it('two users same emoji on same target → both added; chips count = 2 in listReactionsForArc', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)

    const a = await toggleReactionImpl(ctx, {
      targetKind: 'comment',
      targetId: 'cmt-7',
      emoji: '🎉',
      userId: 'user-A',
    })
    const b = await toggleReactionImpl(ctx, {
      targetKind: 'comment',
      targetId: 'cmt-7',
      emoji: '🎉',
      userId: 'user-B',
    })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.action).toBe('added')
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.action).toBe('added')
    expect(sql.reactions).toHaveLength(2)

    const list = listReactionsForArc(ctx, {})
    const onTarget = list.reactions.filter(
      (r) => r.targetKind === 'comment' && r.targetId === 'cmt-7' && r.emoji === '🎉',
    )
    expect(onTarget).toHaveLength(2)
    const userIds = onTarget.map((r) => r.userId).sort()
    expect(userIds).toEqual(['user-A', 'user-B'])
  })

  it('different emojis from same user on same target → both inserted; two distinct chip rollups', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)

    await toggleReactionImpl(ctx, {
      targetKind: 'chat',
      targetId: 'chat-9',
      emoji: '👍',
      userId: 'user-A',
    })
    await toggleReactionImpl(ctx, {
      targetKind: 'chat',
      targetId: 'chat-9',
      emoji: '🚀',
      userId: 'user-A',
    })

    expect(sql.reactions).toHaveLength(2)
    const list = listReactionsForArc(ctx, {})
    const emojis = list.reactions
      .filter((r) => r.targetKind === 'chat' && r.targetId === 'chat-9' && r.userId === 'user-A')
      .map((r) => r.emoji)
      .sort()
    expect(emojis).toEqual(['👍', '🚀'])
  })

  it('rejects empty targetId with invalid_target_id (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await toggleReactionImpl(ctx, {
      targetKind: 'comment',
      targetId: '',
      emoji: '👍',
      userId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'invalid_target_id', status: 422 })
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })

  it('rejects unknown targetKind with invalid_target_kind (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await toggleReactionImpl(ctx, {
      targetKind: 'transcript',
      targetId: 'cmt-1',
      emoji: '👍',
      userId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'invalid_target_kind', status: 422 })
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })

  it('rejects empty emoji with invalid_emoji (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await toggleReactionImpl(ctx, {
      targetKind: 'chat',
      targetId: 'chat-1',
      emoji: '',
      userId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'invalid_emoji', status: 422 })
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })

  it('rejects oversized emoji (>16 chars) with invalid_emoji (422)', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const res = await toggleReactionImpl(ctx, {
      targetKind: 'chat',
      targetId: 'chat-1',
      emoji: 'x'.repeat(17),
      userId: 'user-A',
    })
    expect(res).toEqual({ ok: false, error: 'invalid_emoji', status: 422 })
    expect(broadcastArcRoom).not.toHaveBeenCalled()
  })
})

describe('listReactionsForArc', () => {
  it('returns rows sorted by created_at DESC', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)

    let nowCounter = 1000
    const realNow = Date.now
    Date.now = () => nowCounter

    try {
      nowCounter = 1000
      await toggleReactionImpl(ctx, {
        targetKind: 'comment',
        targetId: 'cmt-old',
        emoji: '👍',
        userId: 'u1',
      })
      nowCounter = 2000
      await toggleReactionImpl(ctx, {
        targetKind: 'comment',
        targetId: 'cmt-mid',
        emoji: '👍',
        userId: 'u1',
      })
      nowCounter = 3000
      await toggleReactionImpl(ctx, {
        targetKind: 'comment',
        targetId: 'cmt-new',
        emoji: '👍',
        userId: 'u1',
      })
    } finally {
      Date.now = realNow
    }

    const list = listReactionsForArc(ctx, {})
    expect(list.reactions.map((r) => r.targetId)).toEqual(['cmt-new', 'cmt-mid', 'cmt-old'])
    expect(list.reactions.map((r) => r.createdAt)).toEqual([3000, 2000, 1000])
  })

  it('sets the synthetic id field on each row', async () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    await toggleReactionImpl(ctx, {
      targetKind: 'chat',
      targetId: 'chat-X',
      emoji: '🙏',
      userId: 'user-Z',
    })
    const list = listReactionsForArc(ctx, {})
    expect(list.reactions).toHaveLength(1)
    expect(list.reactions[0].id).toBe('chat:chat-X:user-Z:🙏')
  })

  it('returns an empty array for a fresh arc', () => {
    const sql = new FakeSql()
    const ctx = createCtx(sql)
    const list = listReactionsForArc(ctx, {})
    expect(list.reactions).toEqual([])
  })
})
