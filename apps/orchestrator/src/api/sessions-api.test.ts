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

describe('GET /api/sessions/search', () => {
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

  it('returns empty sessions when no query provided', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions/search')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ sessions: [] })
    // Should not even hit the db when q is empty
    expect(fakeDb.db.select).not.toHaveBeenCalled()
  })

  it('runs a select against agent_sessions and returns the rows', async () => {
    const mockSessions = [{ id: 'sess-1', project: 'foo', status: 'done', summary: 'did stuff' }]
    fakeDb.data.select = mockSessions

    const app = makeApp(env)
    const res = await app.request('/api/sessions/search?q=stuff')

    expect(res.status).toBe(200)
    // Spec #68 P2: rows are annotated with `isOwner` (no userId on this fixture
    // so the caller `user-1` is not the owner).
    await expect(res.json()).resolves.toEqual({
      sessions: mockSessions.map((s) => ({ ...s, isOwner: false })),
    })
    expect(fakeDb.db.select).toHaveBeenCalled()
  })
})

describe('GET /api/sessions/history', () => {
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

  it('returns empty list with nextOffset:null when no rows', async () => {
    fakeDb.data.select = []
    const app = makeApp(env)
    const res = await app.request('/api/sessions/history')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ sessions: [], nextOffset: null })
  })

  it('returns rows and nextOffset when result exactly fills the page', async () => {
    const rows = [
      { id: 's1', status: 'done' },
      { id: 's2', status: 'running' },
    ]
    fakeDb.data.select = rows

    const app = makeApp(env)
    const res = await app.request('/api/sessions/history?limit=2&offset=0')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { nextOffset: number | null; sessions: unknown[] }
    expect(body.sessions).toHaveLength(2)
    expect(body.nextOffset).toBe(2)
  })

  it('returns null nextOffset when result is smaller than the page', async () => {
    fakeDb.data.select = [{ id: 's1', status: 'done' }]

    const app = makeApp(env)
    const res = await app.request('/api/sessions/history?limit=10&offset=0')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { nextOffset: number | null; sessions: unknown[] }
    expect(body.sessions).toHaveLength(1)
    expect(body.nextOffset).toBeNull()
  })
})

describe('POST /api/sessions', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>
  let lastFetchBody: any

  function createMockSessionDO() {
    return {
      fetch: vi.fn().mockImplementation(async (req: Request) => {
        lastFetchBody = await req.json()
        return new Response(JSON.stringify({ ok: true, session_id: 'do-123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    }
  }

  beforeEach(() => {
    lastFetchBody = null
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    env.SESSION_AGENT.newUniqueId.mockReturnValue({ toString: () => 'new-do-id' })
    env.SESSION_AGENT.get.mockReturnValue(createMockSessionDO())
    env.CC_GATEWAY_URL = 'wss://gateway.test'
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })
  })

  it('returns 400 when project or prompt is missing', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'my-project' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Missing required fields/)
  })

  it('creates a session and returns session_id', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'my-project', prompt: 'do stuff' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session_id: string }
    expect(body.session_id).toBe('new-do-id')
    // The route inserts a row into agent_sessions
    expect(fakeDb.db.insert).toHaveBeenCalled()
  })

  it('does not pass runner_session_id to DO for a regular spawn', async () => {
    const app = makeApp(env)
    await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'my-project', prompt: 'do stuff' }),
    })

    expect(lastFetchBody).toBeDefined()
    expect(lastFetchBody.runner_session_id).toBeUndefined()
    expect(lastFetchBody.project).toBe('my-project')
    expect(lastFetchBody.prompt).toBe('do stuff')
  })

  it('passes runner_session_id and agent to DO for resume', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'my-project',
        prompt: 'resume',
        runner_session_id: 'sdk-abc-123',
        agent: 'claude',
      }),
    })

    expect(res.status).toBe(201)
    expect(lastFetchBody).toBeDefined()
    expect(lastFetchBody.runner_session_id).toBe('sdk-abc-123')
    expect(lastFetchBody.agent).toBe('claude')
    expect(lastFetchBody.project).toBe('my-project')
    expect(lastFetchBody.prompt).toBe('resume')
  })

  it('uses upsert (insert + onConflictDoUpdate) on resume to swap a stale discovered row', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'my-project',
        prompt: 'resume',
        runner_session_id: 'sdk-abc-123',
        agent: 'claude',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session_id: string }
    expect(body.session_id).toBe('new-do-id')
    // Insert was called with the new row (resume goes through onConflictDoUpdate)
    expect(fakeDb.db.insert).toHaveBeenCalled()
  })

  it('uses client_session_id verbatim when supplied (optimistic create)', async () => {
    env.SESSION_AGENT.idFromName.mockReturnValue({ toString: () => 'named-do-id' })
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'my-project',
        prompt: 'do stuff',
        client_session_id: 'sess-abc-123',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session_id: string }
    expect(body.session_id).toBe('sess-abc-123')
    expect(env.SESSION_AGENT.idFromName).toHaveBeenCalledWith('sess-abc-123')
    expect(env.SESSION_AGENT.newUniqueId).not.toHaveBeenCalled()
  })

  it('rejects client_session_id that looks like a raw DO hex id', async () => {
    const app = makeApp(env)
    const hex64 = '0'.repeat(64)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'my-project',
        prompt: 'do stuff',
        client_session_id: hex64,
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_client_session_id')
  })

  it('rejects malformed client_session_id', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'my-project',
        prompt: 'do stuff',
        client_session_id: 'bad id with spaces',
      }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 500 when DO returns non-ok response', async () => {
    env.SESSION_AGENT.get.mockReturnValue({
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'boom' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    })

    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'my-project', prompt: 'do stuff' }),
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Failed to create session')
  })
})

describe('route ordering: /search and /history before /:id', () => {
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

  it('/api/sessions/search is not caught by /:id route', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions/search?q=test')

    expect(res.status).toBe(200)
    // /:id would invoke the SessionDO; /search just runs a select.
    expect(env.SESSION_AGENT.get).not.toHaveBeenCalled()
  })

  it('/api/sessions/history is not caught by /:id route', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions/history')

    expect(res.status).toBe(200)
    expect(env.SESSION_AGENT.get).not.toHaveBeenCalled()
  })
})
