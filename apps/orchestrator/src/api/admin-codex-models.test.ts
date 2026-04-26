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

describe('GET /api/admin/codex-models', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('returns the list of models for admin', async () => {
    asAdmin()
    const rows = [
      {
        id: 'gpt-5.1',
        name: 'gpt-5.1',
        contextWindow: 1000000,
        maxOutputTokens: null,
        enabled: true,
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
      },
    ]
    fakeDb.data.select = rows

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { models: unknown[] }
    expect(body.models).toEqual(rows)
  })

  it('returns 403 for a non-admin caller', async () => {
    asUser()

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models')

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('forbidden')
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models')

    expect(res.status).toBe(401)
  })
})

describe('POST /api/admin/codex-models', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('creates a new model and returns 201', async () => {
    asAdmin()
    const inserted = {
      id: 'o3',
      name: 'o3',
      contextWindow: 200000,
      maxOutputTokens: null,
      enabled: true,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }
    // Sequence of chains in handler (the resolver pulls one queue entry per
    // terminal chain regardless of kind):
    //   1. SELECT uniqueness pre-check → empty
    //   2. INSERT → ignored
    //   3. SELECT post-insert row read → [inserted]
    fakeDb.data.queue = [[], [], [inserted]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'o3', context_window: 200000 }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual(inserted)
    expect(fakeDb.db.insert).toHaveBeenCalled()
  })

  it('returns 400 when context_window is missing', async () => {
    asAdmin()

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'o3' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; field: string }
    expect(body.error).toBe('missing_required_field')
    expect(body.field).toBe('context_window')
  })

  it('returns 400 when context_window is non-positive', async () => {
    asAdmin()

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'o3', context_window: 0 }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_context_window')
  })

  it('returns 400 when name is missing', async () => {
    asAdmin()

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context_window: 200000 }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; field: string }
    expect(body.error).toBe('missing_required_field')
    expect(body.field).toBe('name')
  })

  it('returns 409 when name is duplicate', async () => {
    asAdmin()
    fakeDb.data.queue = [[{ id: 'o3' }]] // pre-check finds an existing row

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'o3', context_window: 200000 }),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; name: string }
    expect(body.error).toBe('duplicate_model_name')
    expect(body.name).toBe('o3')
  })

  it('returns 403 for non-admin caller', async () => {
    asUser()

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'o3', context_window: 200000 }),
    })

    expect(res.status).toBe(403)
  })
})

describe('PUT /api/admin/codex-models/:id', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('updates a model and returns the new row', async () => {
    asAdmin()
    const existing = {
      id: 'o3',
      name: 'o3',
      contextWindow: 200000,
      maxOutputTokens: null,
      enabled: true,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }
    const updated = { ...existing, contextWindow: 400000 }
    // Sequence: SELECT existence-check → UPDATE → SELECT post-update read.
    fakeDb.data.queue = [[existing], [], [updated]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models/o3', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context_window: 400000 }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.contextWindow).toBe(400000)
    expect(fakeDb.db.update).toHaveBeenCalled()
  })

  it('returns 404 when id does not exist', async () => {
    asAdmin()
    fakeDb.data.queue = [[]] // existence-check → empty

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models/missing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })

  it('returns 400 name_immutable when body.name differs from existing name', async () => {
    asAdmin()
    const existing = {
      id: 'o3',
      name: 'o3',
      contextWindow: 200000,
      maxOutputTokens: null,
      enabled: true,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }
    // Only the existence-check SELECT runs before the rename guard fires.
    fakeDb.data.queue = [[existing]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models/o3', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'o3-renamed' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('name_immutable')
    // The rename must short-circuit before any UPDATE / second SELECT.
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('returns 403 for non-admin caller', async () => {
    asUser()

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models/o3', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/admin/codex-models/:id', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('deletes a model and returns 204', async () => {
    asAdmin()
    // SELECT existence-check → DELETE.
    fakeDb.data.queue = [[{ id: 'o3' }], []]

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models/o3', {
      method: 'DELETE',
    })

    expect(res.status).toBe(204)
    expect(fakeDb.db.delete).toHaveBeenCalled()
  })

  it('returns 404 when id does not exist', async () => {
    asAdmin()
    fakeDb.data.queue = [[]]

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models/missing', {
      method: 'DELETE',
    })

    expect(res.status).toBe(404)
  })

  it('returns 403 for non-admin caller', async () => {
    asUser()

    const app = makeApp(env)
    const res = await app.request('/api/admin/codex-models/o3', {
      method: 'DELETE',
    })

    expect(res.status).toBe(403)
  })
})
