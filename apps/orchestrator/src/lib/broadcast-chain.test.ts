// Unit tests for `broadcastChainRow` — fanout to every online user from
// `user_presence` (chains are globally visible per /api/chains, so the
// fan-out target set mirrors the public-session path in
// `broadcast-session.ts`).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from '~/api/test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

const broadcastSyncedDeltaMock = vi.fn(async () => {})
vi.mock('~/lib/broadcast-synced-delta', () => ({
  broadcastSyncedDelta: (...args: unknown[]) => broadcastSyncedDeltaMock(...args),
}))

const buildChainRowMock = vi.fn(async () => null as unknown)
vi.mock('~/lib/chains', () => ({
  buildChainRow: (...args: unknown[]) => buildChainRowMock(...args),
}))

import { broadcastChainRow } from './broadcast-chain'

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

describe('broadcastChainRow', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = makeEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    broadcastSyncedDeltaMock.mockClear()
    buildChainRowMock.mockReset()
  })

  it('rebuild + fanout: emits an `update` op to every online user', async () => {
    const row = { issueNumber: 42, column: 'research', sessions: [] }
    buildChainRowMock.mockResolvedValueOnce(row)
    // user_presence SELECT.
    fakeDb.data.queue = [[{ userId: 'user-A' }, { userId: 'user-B' }]]
    const { ctx, waited } = makeCtx()

    await broadcastChainRow(env, ctx, 42, { actorUserId: 'user-A' })
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(2)
    const recipients = broadcastSyncedDeltaMock.mock.calls.map((c) => c[1] as string).sort()
    expect(recipients).toEqual(['user-A', 'user-B'])
    for (const call of broadcastSyncedDeltaMock.mock.calls) {
      expect(call[2]).toBe('chains')
      expect(call[3]).toEqual([{ type: 'update', value: row }])
    }
  })

  it('null row: emits a `delete` op (chain has no sessions and no GH meta)', async () => {
    buildChainRowMock.mockResolvedValueOnce(null)
    fakeDb.data.queue = [[{ userId: 'user-A' }]]
    const { ctx, waited } = makeCtx()

    await broadcastChainRow(env, ctx, 99, { actorUserId: 'user-A' })
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(1)
    expect(broadcastSyncedDeltaMock.mock.calls[0][3]).toEqual([{ type: 'delete', key: '99' }])
  })

  it('actor not yet in user_presence: still receives the delta', async () => {
    const row = { issueNumber: 7, column: 'backlog', sessions: [] }
    buildChainRowMock.mockResolvedValueOnce(row)
    // Presence missing the actor — common when the actor's UserSettings
    // WS hasn't connected yet (fresh login, page just loaded).
    fakeDb.data.queue = [[{ userId: 'user-A' }]]
    const { ctx, waited } = makeCtx()

    await broadcastChainRow(env, ctx, 7, { actorUserId: 'actor' })
    await Promise.all(waited)

    const recipients = broadcastSyncedDeltaMock.mock.calls.map((c) => c[1] as string).sort()
    expect(recipients).toEqual(['actor', 'user-A'])
  })

  it('non-finite issue number: no-op', async () => {
    const { ctx, waited } = makeCtx()
    await broadcastChainRow(env, ctx, Number.NaN, { actorUserId: 'a' })
    await Promise.all(waited)

    expect(buildChainRowMock).not.toHaveBeenCalled()
    expect(broadcastSyncedDeltaMock).not.toHaveBeenCalled()
  })

  it('zero online users + no actor: no broadcast', async () => {
    buildChainRowMock.mockResolvedValueOnce({ issueNumber: 1 })
    fakeDb.data.queue = [[]]
    const { ctx, waited } = makeCtx()

    await broadcastChainRow(env, ctx, 1)
    await Promise.all(waited)

    expect(broadcastSyncedDeltaMock).not.toHaveBeenCalled()
  })
})
