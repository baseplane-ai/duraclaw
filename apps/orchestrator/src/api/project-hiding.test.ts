import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const mockProjects = [
  { name: 'alpha', path: '/data/projects/alpha' },
  { name: 'beta', path: '/data/projects/beta' },
  { name: 'gamma', path: '/data/projects/gamma' },
]

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

function createMockD1(hiddenProjects: string[] | null = null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi
          .fn()
          .mockResolvedValue(hiddenProjects ? { value: JSON.stringify(hiddenProjects) } : null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }
}

function createMockEnv(
  registry: ReturnType<typeof createMockRegistry>,
  hiddenProjects: string[] | null = null,
) {
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
    AUTH_DB: createMockD1(hiddenProjects),
    BETTER_AUTH_SECRET: 'test-secret',
    ASSETS: {},
    CC_GATEWAY_URL: 'wss://gateway.test',
    CC_GATEWAY_SECRET: 'gw-secret',
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

describe('project hiding', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })

    // Mock global fetch for gateway calls
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockProjects), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('GET /api/gateway/projects', () => {
    it('returns all projects when no hidden preferences exist', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, null)
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)
      expect(body.map((p: any) => p.name)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('filters out hidden projects', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, ['beta'])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(2)
      expect(body.map((p: any) => p.name)).toEqual(['alpha', 'gamma'])
    })

    it('filters out multiple hidden projects', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, ['alpha', 'gamma'])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(1)
      expect(body[0].name).toBe('beta')
    })

    it('returns all projects when hidden list is empty', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, [])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)
    })

    it('queries user_preferences with correct user_id and key', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, null)
      const app = makeApp(env)

      await app.request('/api/gateway/projects')

      expect(env.AUTH_DB.prepare).toHaveBeenCalledWith(
        "SELECT value FROM user_preferences WHERE user_id = ? AND key = 'hidden_projects'",
      )
      const bindMock = env.AUTH_DB.prepare.mock.results[0].value.bind
      expect(bindMock).toHaveBeenCalledWith('user-1')
    })
  })

  describe('GET /api/gateway/projects/all', () => {
    it('returns all projects with hidden: false when no hidden prefs', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, null)
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects/all')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)
      expect(body.every((p: any) => p.hidden === false)).toBe(true)
    })

    it('marks hidden projects with hidden: true', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, ['beta', 'gamma'])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects/all')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)

      const byName = Object.fromEntries(body.map((p: any) => [p.name, p.hidden]))
      expect(byName).toEqual({
        alpha: false,
        beta: true,
        gamma: true,
      })
    })

    it('includes all project fields plus hidden flag', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, ['alpha'])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects/all')
      expect(res.status).toBe(200)

      const body = await res.json()
      const alphaProject = body.find((p: any) => p.name === 'alpha')
      expect(alphaProject).toEqual({
        name: 'alpha',
        path: '/data/projects/alpha',
        hidden: true,
      })
    })

    it('returns 502 when gateway is unreachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))

      const registry = createMockRegistry()
      const env = createMockEnv(registry, null)
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects/all')
      expect(res.status).toBe(502)

      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('connection refused')
    })
  })

  describe('GET /api/projects', () => {
    it('returns all projects when no hidden preferences exist', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, null)
      const app = makeApp(env)

      const res = await app.request('/api/projects')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { projects: any[] }
      expect(body.projects).toHaveLength(3)
      expect(body.projects.map((p: any) => p.name)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('filters out hidden projects', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, ['alpha', 'beta'])
      const app = makeApp(env)

      const res = await app.request('/api/projects')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { projects: any[] }
      expect(body.projects).toHaveLength(1)
      expect(body.projects[0].name).toBe('gamma')
    })

    it('does not fetch sessions for hidden projects', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry, ['beta'])
      const app = makeApp(env)

      await app.request('/api/projects')

      // listSessionsByProject should only be called for visible projects
      expect(registry.listSessionsByProject).toHaveBeenCalledTimes(2)
      expect(registry.listSessionsByProject).toHaveBeenCalledWith('alpha', 'user-1')
      expect(registry.listSessionsByProject).toHaveBeenCalledWith('gamma', 'user-1')
      expect(registry.listSessionsByProject).not.toHaveBeenCalledWith('beta', 'user-1')
    })
  })
})
