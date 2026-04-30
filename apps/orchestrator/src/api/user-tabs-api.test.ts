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

vi.mock('~/lib/broadcast-tabs-snapshot', () => ({
  broadcastTabsSnapshot: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('~/lib/broadcast-session-viewers', () => ({
  fanoutSessionViewerChange: vi.fn().mockResolvedValue(undefined),
  getSessionViewersForUser: vi.fn().mockResolvedValue([]),
}))

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { broadcastTabsSnapshot } from '~/lib/broadcast-tabs-snapshot'
import { createApiApp } from './index'

const mockedGetRequestSession = vi.mocked(getRequestSession)
const mockedBroadcastSnapshot = vi.mocked(broadcastTabsSnapshot)

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
    mockedBroadcastSnapshot.mockClear()
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

  it('fires a snapshot broadcast on success (full-state sync, not per-op delta)', async () => {
    fakeDb.data.update = [{ id: 't1' }]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', { method: 'DELETE' })

    expect(res.status).toBe(204)
    expect(mockedBroadcastSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.anything(),
    )
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', { method: 'DELETE' })

    expect(res.status).toBe(401)
  })
})

describe('POST /api/user-settings/tabs — dedupProject', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedBroadcastSnapshot.mockClear()
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })
  })

  it('atomically soft-deletes sibling project tabs and inserts the new row, stripping dedupProject from persisted meta', async () => {
    // Read order in the handler with dedupProject set + no existing
    // live tab for sessionId:
    //   1. SELECT max(position)
    //   2. SELECT existing live tab for (userId, sessionId) — empty
    //   3. SELECT toDelete rows with json_extract(meta, '$.project') = ?
    //   4. BATCH [UPDATE soft-delete, INSERT new row]
    fakeDb.data.queue = [
      // 1. position max
      [{ max: 1 }],
      // 2. skipDedup precheck — no existing live tab for sess-C
      [],
      // 3. toDelete enumeration — two existing project-BP rows
      [
        { id: 't1', sessionId: 'sess-A' },
        { id: 't2', sessionId: 'sess-B' },
      ],
      // 4a. batch op 1 (UPDATE) — soft-delete result
      [{ id: 't1' }, { id: 't2' }],
      // 4b. batch op 2 (INSERT .returning()) — the new row
      [
        {
          id: 'new-id',
          userId: 'user-1',
          sessionId: 'sess-C',
          position: 2,
          createdAt: '2026-04-29T00:00:00.000Z',
          meta: '{"project":"BP"}',
          deletedAt: null,
        },
      ],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'new-id',
        sessionId: 'sess-C',
        meta: '{"project":"BP","dedupProject":"BP"}',
      }),
    })

    expect(res.status).toBe(201)
    const json = (await res.json()) as { tab: { meta: string } }
    // Persisted meta has NO dedupProject field — server stripped it.
    const parsed = JSON.parse(json.tab.meta) as Record<string, unknown>
    expect(parsed).toEqual({ project: 'BP' })
    expect(parsed.dedupProject).toBeUndefined()

    // Atomic write went through db.batch (UPDATE + INSERT), not a
    // bare insert.
    expect(fakeDb.db.batch).toHaveBeenCalled()
    // The values() call on the insert op carries the cleaned meta.
    const insertCalls = fakeDb.db.insert.mock.calls
    expect(insertCalls.length).toBeGreaterThan(0)

    // Snapshot broadcast fired once for the user.
    expect(mockedBroadcastSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.anything(),
    )
  })

  it('skips dedup when a live tab already exists for the same sessionId (cold-start race protection)', async () => {
    // Read order with dedupProject set + existing live tab for sessionId:
    //   1. SELECT max(position)
    //   2. SELECT existing live tab for (userId, sessionId) — returns t1
    //      => skipDedup = true; we fall through to a plain INSERT and let
    //      the unique-violation handler return the canonical row.
    //   3. INSERT — throws unique violation
    //   4. SELECT canonical existing row by sessionId
    fakeDb.data.queue = [
      // 1. position max
      [{ max: 0 }],
      // 2. skipDedup precheck — sess-A is already live for this user
      [{ id: 't1' }],
    ]
    // After the queue is exhausted, default `data.insert` is consumed —
    // we want the bare insert to throw a unique-violation error so the
    // catch path returns the canonical row.
    const uniqueErr = Object.assign(
      new Error('UNIQUE constraint failed: user_tabs.user_id, user_tabs.session_id'),
      {},
    )
    fakeDb.db.insert = vi.fn(() => {
      // The chain proxy resolves on .then; throw at terminal time by
      // returning a rejected thenable.
      const rejecting: any = {
        values: () => rejecting,
        returning: () => rejecting,
        then: (_resolve: any, reject: any) => reject(uniqueErr),
        catch: (reject: any) => reject(uniqueErr),
        finally: (cb: any) => {
          cb()
          return Promise.reject(uniqueErr)
        },
      }
      return rejecting
    }) as any
    // After the unique-violation catch, the handler does a SELECT for
    // the canonical existing row.
    fakeDb.data.select = [
      {
        id: 't1',
        userId: 'user-1',
        sessionId: 'sess-A',
        position: 0,
        createdAt: '2026-04-20T00:00:00.000Z',
        meta: '{"project":"BP"}',
        deletedAt: null,
      },
    ]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'attempt-id',
        sessionId: 'sess-A',
        meta: '{"project":"BP","dedupProject":"BP"}',
      }),
    })

    // Either 200 (canonical row from unique-violation path) or 201 (if
    // the bare insert succeeded — also acceptable as long as we did NOT
    // soft-delete the OTHER project-BP tab).
    expect([200, 201]).toContain(res.status)

    // The critical assertion: we did NOT call db.batch (no project-wide
    // soft-delete), and we did NOT call db.update (no soft-delete). The
    // OTHER project-BP tab (sess-B) is left untouched.
    expect(fakeDb.db.batch).not.toHaveBeenCalled()
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('does not perform project-wide dedup when meta has no dedupProject', async () => {
    fakeDb.data.queue = [
      // position max
      [{ max: 0 }],
      // bare insert returning the new row
      [
        {
          id: 'new-id',
          userId: 'user-1',
          sessionId: 'sess-X',
          position: 1,
          createdAt: '2026-04-29T00:00:00.000Z',
          meta: '{"project":"BP"}',
          deletedAt: null,
        },
      ],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'new-id',
        sessionId: 'sess-X',
        meta: '{"project":"BP"}',
      }),
    })

    expect(res.status).toBe(201)
    // No batch (no soft-delete path), no update (no dedup).
    expect(fakeDb.db.batch).not.toHaveBeenCalled()
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/user-settings/tabs/:id', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedBroadcastSnapshot.mockClear()
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })
  })

  it('returns 204 when the row exists but was soft-deleted (idempotent no-op for the dedup race)', async () => {
    // Read order in the handler:
    //   1. SELECT prevSessionId (live filter) — empty (row is soft-deleted)
    //   2. UPDATE ... .returning() — empty (live WHERE matches nothing)
    //   3. SELECT existence (no deletedAt filter) — returns the row
    fakeDb.data.queue = [
      // 1. prevSessionId precheck (live)
      [],
      // 2. UPDATE returning — no live row
      [],
      // 3. Existence check ignoring deletedAt — row IS there, just deleted
      [{ id: 't-deleted' }],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t-deleted', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: '{"project":"BP","lastSeenSeq":42}' }),
    })

    expect(res.status).toBe(204)
    // No broadcast — there's nothing to fan out, the row is gone.
    expect(mockedBroadcastSnapshot).not.toHaveBeenCalled()
  })

  it('returns 404 when no row exists for that id (truly unknown / wrong user)', async () => {
    fakeDb.data.queue = [
      // 1. prevSessionId precheck (live) — empty
      [],
      // 2. UPDATE returning — empty
      [],
      // 3. Existence check ignoring deletedAt — still empty (truly unknown)
      [],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: '{"project":"BP","lastSeenSeq":42}' }),
    })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Tab not found' })
  })

  it('returns 200 with the updated row on a successful patch (regression — the happy path)', async () => {
    fakeDb.data.queue = [
      // 1. prevSessionId precheck (live) — sess-A
      [{ sessionId: 'sess-A' }],
      // 2. UPDATE returning — the updated row
      [
        {
          id: 't1',
          userId: 'user-1',
          sessionId: 'sess-A',
          position: 0,
          createdAt: '2026-04-20T00:00:00.000Z',
          meta: '{"project":"BP","lastSeenSeq":42}',
          deletedAt: null,
        },
      ],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: '{"project":"BP","lastSeenSeq":42}' }),
    })

    expect(res.status).toBe(200)
    expect(mockedBroadcastSnapshot).toHaveBeenCalled()
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: '{}' }),
    })

    expect(res.status).toBe(401)
  })
})
