// Unit tests for spec #68 B7 — `broadcastSessionRow` visibility fanout.
//
// Covers the two cases called out in test id `p3-fanout`:
//   - private session → single broadcast to the owner
//   - public session → broadcast to every online user in `user_presence`

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from '~/api/test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

const broadcastSyncedDeltaMock = vi.fn(async () => {})
vi.mock('~/lib/broadcast-synced-delta', () => ({
  broadcastSyncedDelta: (...args: unknown[]) => broadcastSyncedDeltaMock(...args),
}))

import { broadcastSessionRow } from './broadcast-session'

function makeEnv() {
  return { AUTH_DB: {} } as any
}

function makeCtx() {
  const waited: Promise<unknown>[] = []
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        waited.push(p)
      },
    },
    waited,
  }
}

describe('broadcastSessionRow — visibility fanout', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = makeEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    broadcastSyncedDeltaMock.mockClear()
  })

  it('private session: broadcasts once to the owner only (p3-fanout)', async () => {
    // Single SELECT: the agent_sessions row.
    fakeDb.data.queue = [[{ id: 's-priv', userId: 'owner-1', visibility: 'private', project: 'p' }]]
    const { ctx, waited } = makeCtx()

    await broadcastSessionRow(env, ctx, 's-priv', 'update')
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(1)
    const [, uid, collection, ops] = broadcastSyncedDeltaMock.mock.calls[0] as [
      unknown,
      string,
      string,
      Array<{ type: string; value: { id: string } }>,
    ]
    expect(uid).toBe('owner-1')
    expect(collection).toBe('agent_sessions')
    expect(ops).toEqual([
      {
        type: 'update',
        value: { id: 's-priv', userId: 'owner-1', visibility: 'private', project: 'p' },
      },
    ])
  })

  it('public session: fans out to every online user in user_presence (p3-fanout)', async () => {
    // Two SELECTs in sequence:
    //   1) agent_sessions row lookup
    //   2) user_presence index
    fakeDb.data.queue = [
      [{ id: 's-pub', userId: 'owner-1', visibility: 'public', project: 'p' }],
      [{ userId: 'user-A' }, { userId: 'user-B' }, { userId: 'owner-1' }],
    ]
    const { ctx, waited } = makeCtx()

    await broadcastSessionRow(env, ctx, 's-pub', 'insert')
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(3)
    const recipients = broadcastSyncedDeltaMock.mock.calls.map((c) => c[1] as string).sort()
    expect(recipients).toEqual(['owner-1', 'user-A', 'user-B'])
    for (const call of broadcastSyncedDeltaMock.mock.calls) {
      expect(call[2]).toBe('agent_sessions')
      expect(call[3]).toEqual([
        {
          type: 'insert',
          value: { id: 's-pub', userId: 'owner-1', visibility: 'public', project: 'p' },
        },
      ])
    }
  })

  it('public session: includes the owner even if not in user_presence', async () => {
    fakeDb.data.queue = [
      [{ id: 's-pub', userId: 'owner-1', visibility: 'public', project: 'p' }],
      [{ userId: 'user-A' }],
    ]
    const { ctx, waited } = makeCtx()

    await broadcastSessionRow(env, ctx, 's-pub', 'update')
    await Promise.all(waited)

    const recipients = broadcastSyncedDeltaMock.mock.calls.map((c) => c[1] as string).sort()
    expect(recipients).toEqual(['owner-1', 'user-A'])
  })

  it('system-owned session is suppressed entirely', async () => {
    fakeDb.data.queue = [[{ id: 's-sys', userId: 'system', visibility: 'private', project: 'p' }]]
    const { ctx, waited } = makeCtx()

    await broadcastSessionRow(env, ctx, 's-sys', 'update')
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).not.toHaveBeenCalled()
  })

  it('missing row: no broadcast (cascade-delete race)', async () => {
    fakeDb.data.queue = [[]]
    const { ctx, waited } = makeCtx()

    await broadcastSessionRow(env, ctx, 'missing', 'update')
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).not.toHaveBeenCalled()
  })
})
