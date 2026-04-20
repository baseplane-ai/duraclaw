import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const mockProjects = [
  { name: 'alpha', path: '/data/projects/alpha' },
  { name: 'beta', path: '/data/projects/beta' },
  { name: 'gamma', path: '/data/projects/gamma' },
]

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
    CC_GATEWAY_URL: 'wss://gateway.test',
    CC_GATEWAY_SECRET: 'gw-secret',
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

/**
 * Build the queue of selects the /api/projects route will issue:
 *   1. getHiddenProjects → 1 select on user_preferences (returns [{hiddenProjects}])
 *   2. 1 select on projects (D1-authoritative — GH#32 p4)
 *   3. for each visible project → 1 select on agent_sessions (returns [])
 */
function setupQueueForProjects(fakeDb: ReturnType<typeof makeFakeDb>, hidden: string[] | null) {
  const prefRow = hidden === null ? [] : [{ hiddenProjects: JSON.stringify(hidden) }]
  fakeDb.data.queue.push(prefRow)
  // D1 `projects` table returns all live rows (the handler filters hidden
  // via the preferences set after the query, not in SQL).
  fakeDb.data.queue.push(
    mockProjects.map((p) => ({
      name: p.name,
      displayName: null,
      rootPath: p.path,
      updatedAt: '2026-04-20T00:00:00.000Z',
      deletedAt: null,
    })),
  )
  const visible = hidden ? mockProjects.filter((p) => !hidden.includes(p.name)) : mockProjects
  for (let i = 0; i < visible.length; i++) {
    fakeDb.data.queue.push([])
  }
}

describe('project hiding', () => {
  const originalFetch = globalThis.fetch
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
      fakeDb.data.queue.push([]) // no user_preferences row
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)
      expect(body.map((p: any) => p.name)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('filters out hidden projects', async () => {
      fakeDb.data.queue.push([{ hiddenProjects: JSON.stringify(['beta']) }])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(2)
      expect(body.map((p: any) => p.name)).toEqual(['alpha', 'gamma'])
    })

    it('filters out multiple hidden projects', async () => {
      fakeDb.data.queue.push([{ hiddenProjects: JSON.stringify(['alpha', 'gamma']) }])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(1)
      expect(body[0].name).toBe('beta')
    })

    it('returns all projects when hidden list is empty', async () => {
      fakeDb.data.queue.push([{ hiddenProjects: JSON.stringify([]) }])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)
    })

    it('queries user_preferences via the drizzle select chain', async () => {
      fakeDb.data.queue.push([])
      const app = makeApp(env)

      await app.request('/api/gateway/projects')

      expect(fakeDb.db.select).toHaveBeenCalledTimes(1)
    })
  })

  describe('GET /api/gateway/projects/all', () => {
    it('returns all projects with hidden: false when no hidden prefs', async () => {
      fakeDb.data.queue.push([])
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects/all')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toHaveLength(3)
      expect(body.every((p: any) => p.hidden === false)).toBe(true)
    })

    it('marks hidden projects with hidden: true', async () => {
      fakeDb.data.queue.push([{ hiddenProjects: JSON.stringify(['beta', 'gamma']) }])
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
      fakeDb.data.queue.push([{ hiddenProjects: JSON.stringify(['alpha']) }])
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
      const app = makeApp(env)

      const res = await app.request('/api/gateway/projects/all')
      expect(res.status).toBe(502)

      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('connection refused')
    })
  })

  describe('GET /api/projects', () => {
    it('returns all projects when no hidden preferences exist', async () => {
      setupQueueForProjects(fakeDb, null)
      const app = makeApp(env)

      const res = await app.request('/api/projects')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { projects: any[] }
      expect(body.projects).toHaveLength(3)
      expect(body.projects.map((p: any) => p.name)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('filters out hidden projects', async () => {
      setupQueueForProjects(fakeDb, ['alpha', 'beta'])
      const app = makeApp(env)

      const res = await app.request('/api/projects')
      expect(res.status).toBe(200)

      const body = (await res.json()) as { projects: any[] }
      expect(body.projects).toHaveLength(1)
      expect(body.projects[0].name).toBe('gamma')
    })

    it('does not query agent_sessions for hidden projects', async () => {
      setupQueueForProjects(fakeDb, ['beta'])
      const app = makeApp(env)

      await app.request('/api/projects')

      // 1 select for user_preferences + 1 for D1 projects + 2 for the
      // visible projects' agent_sessions (alpha, gamma) = 4 total.
      expect(fakeDb.db.select).toHaveBeenCalledTimes(4)
    })
  })
})
