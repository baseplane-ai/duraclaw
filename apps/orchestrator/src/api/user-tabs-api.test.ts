import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRequestSession } from './auth-session'
import { installFakeDb, makeFakeDb } from './test-helpers'

vi.mock('./auth-session', () => ({
  getRequestSession: vi.fn(),
}))

vi.mock('./auth-routes', async () => {
  const { Hono } = await import('hono')
  return { authRoutes: new Hono() }
})

vi.mock('~/lib/broadcast-synced-delta', () => ({
  broadcastSyncedDelta: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { createApiApp } from './index'

const mockedGetRequestSession = vi.mocked(getRequestSession)
const mockedBroadcast = vi.mocked(broadcastSyncedDelta)

function createMockEnv() {
  return {
    SESSION_AGENT: {
      newUniqueId: vi.fn(),
      idFromString: vi.fn(),
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn(),
    },
    USER_SETTINGS: {
      idFromName: vi.fn().mockReturnValue('settings-id'),
      get: vi.fn().mockReturnValue({ fetch: vi.fn().mockResolvedValue(new Response(null)) }),
    },
    AUTH_DB: {},
    BETTER_AUTH_SECRET: 'test-secret',
    ASSETS: {},
  } as any
}

function makeApp(env: any) {
  const app = createApiApp()
  const ctx = { waitUntil: vi.fn((p) => p), passThroughOnException: vi.fn() } as any
  return {
    async request(path: string, init?: RequestInit) {
      const url = `http://localhost${path}`
      const req = new Request(url, init)
      return app.fetch(req, env, ctx)
    },
  }
}

describe('GET /api/user-settings/tabs', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })
  })

  it('returns an empty list when the user has no tabs', async () => {
    fakeDb.data.select = []
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ tabs: [] })
  })

  it('returns only non-deleted tabs (soft-delete filter)', async () => {
    const rows = [
      {
        id: 't1',
        userId: 'user-1',
        sessionId: 'sess-1',
        position: 0,
        createdAt: '2026-04-20T00:00:00.000Z',
        deletedAt: null,
      },
    ]
    fakeDb.data.select = rows

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ tabs: rows })

    // Confirm the drizzle chain included an `isNull(deleted_at)` predicate.
    const selectCalls = fakeDb.db.select.mock.calls
    expect(selectCalls.length).toBeGreaterThan(0)
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs')
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/user-settings/tabs/:id', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedBroadcast.mockClear()
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })
  })

  it('soft-deletes via UPDATE (not DELETE) and returns 204', async () => {
    // The handler runs `db.update(userTabs).set({deletedAt: ...}).where(...)
    // .returning({id})` — the fake resolver returns `data.update` for any
    // update terminal.
    fakeDb.data.update = [{ id: 't1' }]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    // UPDATE was called (soft-delete); DELETE was NOT called.
    expect(fakeDb.db.update).toHaveBeenCalled()
    expect(fakeDb.db.delete).not.toHaveBeenCalled()
  })

  it('returns 404 when the tab does not exist (or is already deleted)', async () => {
    fakeDb.data.update = []

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/missing', { method: 'DELETE' })

    expect(res.status).toBe(404)
  })

  it('fires a {type:delete} synced-delta broadcast on success', async () => {
    fakeDb.data.update = [{ id: 't1' }]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(mockedBroadcast).toHaveBeenCalledWith(expect.anything(), 'user-1', 'user_tabs', [
      { type: 'delete', key: 't1' },
    ])
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', { method: 'DELETE' })

    expect(res.status).toBe(401)
  })
})
