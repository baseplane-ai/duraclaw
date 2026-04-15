import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRequestSession } from './auth-session'
import { createApiApp } from './index'

vi.mock('./auth-session', () => ({
  getRequestSession: vi.fn(),
}))

vi.mock('./auth-routes', async () => {
  const { Hono } = await import('hono')
  return { authRoutes: new Hono() }
})

const mockedGetRequestSession = vi.mocked(getRequestSession)

function createMockRegistry(overrides: Record<string, any> = {}) {
  return {
    searchSessions: vi.fn().mockResolvedValue([]),
    listSessionsPaginated: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    listSessions: vi.fn().mockResolvedValue([]),
    listActiveSessions: vi.fn().mockResolvedValue([]),
    listSessionsByProject: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

function createMockEnv(registry: ReturnType<typeof createMockRegistry>) {
  return {
    SESSION_REGISTRY: {
      idFromName: vi.fn().mockReturnValue('registry-id'),
      get: vi.fn().mockReturnValue(registry),
    },
    SESSION_AGENT: {
      newUniqueId: vi.fn(),
      idFromString: vi.fn(),
      get: vi.fn(),
    },
    AUTH_DB: {},
    BETTER_AUTH_SECRET: 'test-secret',
    ASSETS: {},
  } as any
}

function makeApp(env: any) {
  const app = createApiApp()
  // Wrap to inject env bindings
  return {
    async request(path: string, init?: RequestInit) {
      const url = `http://localhost${path}`
      const req = new Request(url, init)
      return app.fetch(req, env)
    },
  }
}

describe('GET /api/sessions/search', () => {
  let registry: ReturnType<typeof createMockRegistry>
  let env: any

  beforeEach(() => {
    registry = createMockRegistry()
    env = createMockEnv(registry)
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
    expect(registry.searchSessions).not.toHaveBeenCalled()
  })

  it('calls searchSessions with the query and returns results', async () => {
    const mockSessions = [{ id: 'sess-1', project: 'foo', status: 'done', summary: 'did stuff' }]
    registry.searchSessions.mockResolvedValue(mockSessions)

    const app = makeApp(env)
    const res = await app.request('/api/sessions/search?q=stuff')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ sessions: mockSessions })
    expect(registry.searchSessions).toHaveBeenCalledWith('user-1', 'stuff')
  })
})

describe('GET /api/sessions/history', () => {
  let registry: ReturnType<typeof createMockRegistry>
  let env: any

  beforeEach(() => {
    registry = createMockRegistry()
    env = createMockEnv(registry)
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })
  })

  it('calls listSessionsPaginated with default options', async () => {
    registry.listSessionsPaginated.mockResolvedValue({ sessions: [], total: 0 })

    const app = makeApp(env)
    const res = await app.request('/api/sessions/history')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ sessions: [], total: 0 })
    expect(registry.listSessionsPaginated).toHaveBeenCalledWith('user-1', {
      sortBy: undefined,
      sortDir: undefined,
      status: undefined,
      project: undefined,
      model: undefined,
      limit: undefined,
      offset: undefined,
    })
  })

  it('forwards query parameters to listSessionsPaginated', async () => {
    const mockResult = {
      sessions: [{ id: 'sess-1', status: 'done' }],
      total: 1,
    }
    registry.listSessionsPaginated.mockResolvedValue(mockResult)

    const app = makeApp(env)
    const res = await app.request(
      '/api/sessions/history?sortBy=created_at&sortDir=asc&status=done&project=myproj&model=opus&limit=10&offset=5',
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(mockResult)
    expect(registry.listSessionsPaginated).toHaveBeenCalledWith('user-1', {
      sortBy: 'created_at',
      sortDir: 'asc',
      status: 'done',
      project: 'myproj',
      model: 'opus',
      limit: 10,
      offset: 5,
    })
  })

  it('returns paginated results with total count', async () => {
    const mockResult = {
      sessions: [
        { id: 's1', status: 'done' },
        { id: 's2', status: 'running' },
      ],
      total: 42,
    }
    registry.listSessionsPaginated.mockResolvedValue(mockResult)

    const app = makeApp(env)
    const res = await app.request('/api/sessions/history?limit=2&offset=0')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; sessions: unknown[] }
    expect(body.total).toBe(42)
    expect(body.sessions).toHaveLength(2)
  })
})

describe('POST /api/sessions', () => {
  let registry: ReturnType<typeof createMockRegistry>
  let env: any
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
    registry = createMockRegistry({
      registerSession: vi.fn().mockResolvedValue(undefined),
      findSessionBySdkId: vi.fn().mockResolvedValue(null),
      replaceSessionForResume: vi.fn().mockResolvedValue(undefined),
    })
    env = createMockEnv(registry)
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
    expect(registry.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'new-do-id',
        userId: 'user-1',
        project: 'my-project',
        status: 'running',
      }),
    )
  })

  it('does not pass sdk_session_id to DO for a regular spawn', async () => {
    const app = makeApp(env)
    await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'my-project', prompt: 'do stuff' }),
    })

    expect(lastFetchBody).toBeDefined()
    expect(lastFetchBody.sdk_session_id).toBeUndefined()
    expect(lastFetchBody.project).toBe('my-project')
    expect(lastFetchBody.prompt).toBe('do stuff')
  })

  it('passes sdk_session_id and agent to DO for resume', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'my-project',
        prompt: 'resume',
        sdk_session_id: 'sdk-abc-123',
        agent: 'claude',
      }),
    })

    expect(res.status).toBe(201)
    expect(lastFetchBody).toBeDefined()
    expect(lastFetchBody.sdk_session_id).toBe('sdk-abc-123')
    expect(lastFetchBody.agent).toBe('claude')
    expect(lastFetchBody.project).toBe('my-project')
    expect(lastFetchBody.prompt).toBe('resume')
  })

  it('replaces existing discovered session on resume instead of creating duplicate', async () => {
    const existingSession = {
      id: 'old-discovered-id',
      project: 'my-project',
      status: 'idle',
      model: 'opus',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      title: 'Old Title',
      summary: 'Old Summary',
      origin: 'discovered',
      sdk_session_id: 'sdk-abc-123',
    }
    registry.findSessionBySdkId.mockResolvedValue(existingSession)

    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'my-project',
        prompt: 'resume',
        sdk_session_id: 'sdk-abc-123',
        agent: 'claude',
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { session_id: string }
    expect(body.session_id).toBe('new-do-id')
    // Should replace the old session, not register a new one
    expect(registry.replaceSessionForResume).toHaveBeenCalledWith(
      'old-discovered-id',
      expect.objectContaining({
        id: 'new-do-id',
        sdk_session_id: 'sdk-abc-123',
        title: 'Old Title',
        summary: 'Old Summary',
      }),
    )
    expect(registry.registerSession).not.toHaveBeenCalled()
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
  let registry: ReturnType<typeof createMockRegistry>
  let env: any

  beforeEach(() => {
    registry = createMockRegistry()
    env = createMockEnv(registry)
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
    // If it hit /:id, getSession would be called with 'search'
    expect(registry.getSession).not.toHaveBeenCalled()
  })

  it('/api/sessions/history is not caught by /:id route', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/sessions/history')

    expect(res.status).toBe(200)
    expect(registry.getSession).not.toHaveBeenCalled()
  })
})
