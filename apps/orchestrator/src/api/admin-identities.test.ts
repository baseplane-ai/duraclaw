import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRequestSession } from './auth-session'
import { installFakeDb, makeFakeDb } from './test-helpers'

/**
 * GH#119 P2: admin-only CRUD for the runner_identities catalog.
 * Mirrors `admin-codex-models.test.ts` — uses the same fakeDb
 * pattern; SQL correctness lives in the migration, not these tests.
 */

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

import { createApiApp } from './index'

const mockedGetRequestSession = vi.mocked(getRequestSession)

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
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
  return {
    async request(path: string, init?: RequestInit) {
      const url = `http://localhost${path}`
      const req = new Request(url, init)
      return app.fetch(req, env, ctx)
    },
  }
}

function asAdmin() {
  mockedGetRequestSession.mockResolvedValue({
    userId: 'admin-1',
    role: 'admin',
    session: { id: 's' },
    user: { id: 'admin-1', role: 'admin' },
  })
}

function asUser() {
  mockedGetRequestSession.mockResolvedValue({
    userId: 'user-1',
    role: 'user',
    session: { id: 's' },
    user: { id: 'user-1', role: 'user' },
  })
}

describe('GET /api/admin/identities', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('returns the list of identities for admin', async () => {
    asAdmin()
    const rows = [
      {
        id: 'id-1',
        name: 'work1',
        homePath: '/home/work1',
        status: 'available',
        cooldownUntil: null,
        lastUsedAt: null,
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
      },
      {
        id: 'id-2',
        name: 'work2',
        homePath: '/home/work2',
        status: 'cooldown',
        cooldownUntil: '2026-05-01T00:00:00.000Z',
        lastUsedAt: '2026-04-25T00:00:00.000Z',
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
      },
    ]
    fakeDb.data.select = rows

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { identities: unknown[] }
    expect(body.identities).toEqual(rows)
  })

  it('returns 403 for a non-admin caller', async () => {
    asUser()

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities')

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('forbidden')
  })
})

describe('POST /api/admin/identities', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('creates a new identity and returns 201', async () => {
    asAdmin()
    const inserted = {
      id: 'gen-uuid',
      name: 'work1',
      homePath: '/home/work1',
      status: 'available',
      cooldownUntil: null,
      lastUsedAt: null,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }
    // Sequence:
    //   1. SELECT uniqueness pre-check → empty
    //   2. INSERT.returning() → [{ id: 'gen-uuid' }]
    //   3. SELECT post-insert row read → [inserted]
    fakeDb.data.queue = [[], [{ id: 'gen-uuid' }], [inserted]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'work1', home_path: '/home/work1' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual(inserted)
    expect(fakeDb.db.insert).toHaveBeenCalled()
  })

  it('returns 400 when name is missing', async () => {
    asAdmin()

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ home_path: '/home/work1' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; field: string }
    expect(body.error).toBe('missing_required_field')
    expect(body.field).toBe('name')
  })

  it('returns 400 when home_path is missing', async () => {
    asAdmin()

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'work1' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; field: string }
    expect(body.error).toBe('missing_required_field')
    expect(body.field).toBe('home_path')
  })

  it('returns 409 when name is duplicate', async () => {
    asAdmin()
    fakeDb.data.queue = [[{ id: 'existing-id' }]] // pre-check finds an existing row

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'work1', home_path: '/home/work1' }),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; name: string }
    expect(body.error).toBe('duplicate_identity_name')
    expect(body.name).toBe('work1')
  })

  it('returns 403 for non-admin caller', async () => {
    asUser()

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'work1', home_path: '/home/work1' }),
    })

    expect(res.status).toBe(403)
  })
})

describe('PUT /api/admin/identities/:id', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('updates status from available to cooldown', async () => {
    asAdmin()
    const existing = {
      id: 'id-1',
      name: 'work1',
      homePath: '/home/work1',
      status: 'available',
      cooldownUntil: null,
      lastUsedAt: null,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }
    const updated = { ...existing, status: 'cooldown' }
    // Sequence: SELECT existence-check → UPDATE → SELECT post-update read.
    fakeDb.data.queue = [[existing], [], [updated]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities/id-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cooldown' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('cooldown')
    expect(fakeDb.db.update).toHaveBeenCalled()
  })

  it('returns 400 on invalid status', async () => {
    asAdmin()
    const existing = {
      id: 'id-1',
      name: 'work1',
      homePath: '/home/work1',
      status: 'available',
      cooldownUntil: null,
      lastUsedAt: null,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }
    fakeDb.data.queue = [[existing]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities/id-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'bogus' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_status')
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('returns 404 when id does not exist', async () => {
    asAdmin()
    fakeDb.data.queue = [[]] // existence-check → empty

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })
})

describe('DELETE /api/admin/identities/:id', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('deletes an identity and returns 204', async () => {
    asAdmin()
    // SELECT existence-check → DELETE.
    fakeDb.data.queue = [[{ id: 'id-1' }], []]

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities/id-1', {
      method: 'DELETE',
    })

    expect(res.status).toBe(204)
    expect(fakeDb.db.delete).toHaveBeenCalled()
  })

  it('returns 404 when id does not exist', async () => {
    asAdmin()
    fakeDb.data.queue = [[]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/identities/missing', {
      method: 'DELETE',
    })

    expect(res.status).toBe(404)
  })
})
