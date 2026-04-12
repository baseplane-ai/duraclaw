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
    getUserPreferences: vi.fn().mockResolvedValue(null),
    setUserPreferences: vi.fn().mockResolvedValue(undefined),
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
  return {
    async request(path: string, init?: RequestInit) {
      const url = `http://localhost${path}`
      const req = new Request(url, init)
      return app.fetch(req, env)
    },
  }
}

describe('GET /api/preferences', () => {
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

  it('returns empty object when no preferences exist', async () => {
    registry.getUserPreferences.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/preferences')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({})
    expect(registry.getUserPreferences).toHaveBeenCalledWith('user-1')
  })

  it('returns stored preferences', async () => {
    const prefs = {
      permission_mode: 'bypassPermissions',
      model: 'claude-sonnet-4-20250514',
      max_budget: 5.0,
      thinking_mode: 'enabled',
      effort: 'medium',
    }
    registry.getUserPreferences.mockResolvedValue(prefs)

    const app = makeApp(env)
    const res = await app.request('/api/preferences')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(prefs)
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/preferences')

    expect(res.status).toBe(401)
  })
})

describe('PUT /api/preferences', () => {
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

  it('calls setUserPreferences with userId and patch', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', effort: 'low' }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(registry.setUserPreferences).toHaveBeenCalledWith('user-1', {
      model: 'claude-sonnet-4-20250514',
      effort: 'low',
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514' }),
    })

    expect(res.status).toBe(401)
  })
})
