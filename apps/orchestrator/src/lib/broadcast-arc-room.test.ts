import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#152 P1.3 WU-E — unit coverage for the member-aware fanout helper.
 *
 * Mocks `drizzle-orm/d1` (member-list lookup) + `~/lib/broadcast-synced-delta`
 * (per-user fanout) so the test can drive each branch in isolation:
 *   - cache miss → loadMembers reads D1, populates cache, fans out
 *   - cache hit  → no D1 read, fans out from cache
 *   - cache stale (expiresAt < Date.now()) → fresh D1 read
 *   - empty member list → no fanout
 *   - purgeArcMemberCache(arcId) → next call re-reads D1
 *
 * Module-level cache reset: the cache is a module-singleton `Map`. Each
 * test calls `purgeArcMemberCache(<arcId>)` for the arc ids it uses to
 * keep tests independent. (No `_resetCacheForTests` export exists — and
 * adding one would mean modifying production code, which is out of
 * scope per the WU brief.)
 */

const broadcastSyncedDeltaMock = vi.fn(async () => undefined)
vi.mock('~/lib/broadcast-synced-delta', () => ({
  broadcastSyncedDelta: (...args: unknown[]) => broadcastSyncedDeltaMock(...args),
}))

// drizzle stub: terminal `await db.select(...).from(...).where(...)`
// resolves to whatever each test sets via `d1State.members`.
const d1State: {
  members: Array<{ userId: string }>
  shouldThrow: boolean
} = { members: [], shouldThrow: false }

vi.mock('drizzle-orm/d1', () => {
  function makeChain(): unknown {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          if (d1State.shouldThrow) {
            const p = Promise.reject(new Error('d1 boom'))
            return p.then.bind(p)
          }
          const p = Promise.resolve(d1State.members)
          return p.then.bind(p)
        }
        if (prop === 'catch') {
          const p = d1State.shouldThrow
            ? Promise.reject(new Error('d1 boom'))
            : Promise.resolve(d1State.members)
          return p.catch.bind(p)
        }
        if (prop === 'finally') {
          const p = d1State.shouldThrow
            ? Promise.reject(new Error('d1 boom'))
            : Promise.resolve(d1State.members)
          return p.finally.bind(p)
        }
        return (..._args: unknown[]) => makeChain()
      },
    }
    return new Proxy(() => {}, handler)
  }
  return {
    drizzle: vi.fn(() => ({
      select: () => makeChain(),
    })),
  }
})

import { broadcastArcRoom, purgeArcMemberCache } from './broadcast-arc-room'

function makeEnv() {
  return { AUTH_DB: {} } as unknown as Parameters<typeof broadcastArcRoom>[0]
}

function makeCtx() {
  const waited: Promise<unknown>[] = []
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p)
      },
    },
    waited,
  }
}

beforeEach(() => {
  broadcastSyncedDeltaMock.mockClear()
  d1State.members = []
  d1State.shouldThrow = false
})

describe('broadcastArcRoom', () => {
  it('reads members from D1 on cache miss and fans out one call per member', async () => {
    purgeArcMemberCache('arc-1')
    d1State.members = [{ userId: 'user-A' }, { userId: 'user-B' }]
    const env = makeEnv()
    const { ctx, waited } = makeCtx()

    await broadcastArcRoom(env, ctx, 'arc-1', 'arcChat:arc-1', [
      { type: 'insert', value: { id: 'msg-1' } },
    ])
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(2)
    const recipients = broadcastSyncedDeltaMock.mock.calls.map((c) => c[1] as string).sort()
    expect(recipients).toEqual(['user-A', 'user-B'])
    for (const call of broadcastSyncedDeltaMock.mock.calls) {
      expect(call[2]).toBe('arcChat:arc-1')
      expect(call[3]).toEqual([{ type: 'insert', value: { id: 'msg-1' } }])
    }
  })

  it('serves from cache on the second call (no D1 read)', async () => {
    purgeArcMemberCache('arc-cached')
    d1State.members = [{ userId: 'user-X' }]
    const env = makeEnv()
    const { ctx, waited } = makeCtx()

    // First call → cache miss → reads D1.
    await broadcastArcRoom(env, ctx, 'arc-cached', 'arcChat:arc-cached', [
      { type: 'insert', value: { id: 'm1' } },
    ])
    await Promise.all(waited)
    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(1)

    // Mutate the D1 stub to a different roster — if the cache works,
    // the second call still uses the old roster (`user-X`), not the new one.
    d1State.members = [{ userId: 'user-Y' }, { userId: 'user-Z' }]

    const ctx2 = makeCtx()
    await broadcastArcRoom(env, ctx2.ctx, 'arc-cached', 'arcChat:arc-cached', [
      { type: 'insert', value: { id: 'm2' } },
    ])
    await Promise.all(ctx2.waited)

    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(2)
    // Second call's recipient must be the cached `user-X`, not `user-Y/Z`.
    expect(broadcastSyncedDeltaMock.mock.calls[1][1]).toBe('user-X')
  })

  it('purgeArcMemberCache(arcId) forces the next call to re-read D1', async () => {
    purgeArcMemberCache('arc-purge')
    d1State.members = [{ userId: 'user-orig' }]
    const env = makeEnv()

    // Prime the cache.
    {
      const { ctx, waited } = makeCtx()
      await broadcastArcRoom(env, ctx, 'arc-purge', 'arcChat:arc-purge', [
        { type: 'insert', value: { id: 'm1' } },
      ])
      await Promise.all(waited)
    }
    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(1)
    expect(broadcastSyncedDeltaMock.mock.calls[0][1]).toBe('user-orig')

    // Purge → next call should hit D1 (which now returns a different roster).
    purgeArcMemberCache('arc-purge')
    d1State.members = [{ userId: 'user-fresh' }]

    {
      const { ctx, waited } = makeCtx()
      await broadcastArcRoom(env, ctx, 'arc-purge', 'arcChat:arc-purge', [
        { type: 'insert', value: { id: 'm2' } },
      ])
      await Promise.all(waited)
    }
    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(2)
    expect(broadcastSyncedDeltaMock.mock.calls[1][1]).toBe('user-fresh')
  })

  it('empty member list → broadcastSyncedDelta is not called', async () => {
    purgeArcMemberCache('arc-empty')
    d1State.members = []
    const env = makeEnv()
    const { ctx, waited } = makeCtx()

    await broadcastArcRoom(env, ctx, 'arc-empty', 'arcChat:arc-empty', [
      { type: 'insert', value: { id: 'm1' } },
    ])
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).not.toHaveBeenCalled()
  })

  it('zero ops → returns immediately without reading D1 or fanning out', async () => {
    purgeArcMemberCache('arc-zero')
    d1State.members = [{ userId: 'should-not-fire' }]
    const env = makeEnv()
    const { ctx, waited } = makeCtx()

    await broadcastArcRoom(env, ctx, 'arc-zero', 'arcChat:arc-zero', [])
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).not.toHaveBeenCalled()
  })

  it('D1 read failure is swallowed (no throw, no fanout)', async () => {
    purgeArcMemberCache('arc-fail')
    d1State.shouldThrow = true
    const env = makeEnv()
    const { ctx, waited } = makeCtx()

    await expect(
      broadcastArcRoom(env, ctx, 'arc-fail', 'arcChat:arc-fail', [
        { type: 'insert', value: { id: 'm1' } },
      ]),
    ).resolves.toBeUndefined()
    await Promise.all(waited)
    expect(broadcastSyncedDeltaMock).not.toHaveBeenCalled()
  })

  it('cache TTL: a stale cache entry (expired) triggers a fresh D1 read', async () => {
    purgeArcMemberCache('arc-ttl')
    d1State.members = [{ userId: 'user-orig' }]
    const env = makeEnv()

    // Seed at "now".
    {
      const { ctx, waited } = makeCtx()
      await broadcastArcRoom(env, ctx, 'arc-ttl', 'arcChat:arc-ttl', [
        { type: 'insert', value: { id: 'm1' } },
      ])
      await Promise.all(waited)
    }
    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(1)

    // Advance Date.now() past the 60s TTL so the cached entry's
    // `expiresAt` falls below `now`.
    const realNow = Date.now
    const fixedNow = realNow() + 120_000
    Date.now = () => fixedNow
    try {
      d1State.members = [{ userId: 'user-after-ttl' }]
      const { ctx, waited } = makeCtx()
      await broadcastArcRoom(env, ctx, 'arc-ttl', 'arcChat:arc-ttl', [
        { type: 'insert', value: { id: 'm2' } },
      ])
      await Promise.all(waited)
    } finally {
      Date.now = realNow
    }
    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(2)
    expect(broadcastSyncedDeltaMock.mock.calls[1][1]).toBe('user-after-ttl')
  })
})
