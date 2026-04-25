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

describe('GET /api/preferences', () => {
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

  it('returns synthesised defaults when no row exists for the user', async () => {
    fakeDb.data.select = []

    const app = makeApp(env)
    const res = await app.request('/api/preferences')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.userId).toBe('user-1')
    expect(body.permissionMode).toBe('default')
    expect(body.thinkingMode).toBe('adaptive')
    expect(body.effort).toBe('xhigh')
    // Defaults are NOT persisted on a GET — only on PUT.
    expect(fakeDb.db.insert).not.toHaveBeenCalled()
  })

  it('returns the stored row when one exists', async () => {
    const stored = {
      userId: 'user-1',
      permissionMode: 'acceptAll',
      model: 'claude-sonnet-4-20250514',
      maxBudget: 5.0,
      thinkingMode: 'on',
      effort: 'medium',
      hiddenProjects: null,
      updatedAt: '2026-04-18T00:00:00.000Z',
    }
    fakeDb.data.select = [stored]

    const app = makeApp(env)
    const res = await app.request('/api/preferences')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(stored)
  })

  it('returns 401 when not authenticated', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const app = makeApp(env)
    const res = await app.request('/api/preferences')

    expect(res.status).toBe(401)
  })
})

describe('PUT /api/preferences', () => {
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

  it('upserts allowed fields and returns the new row', async () => {
    const inserted = {
      userId: 'user-1',
      permissionMode: 'default',
      model: 'claude-sonnet-4-20250514',
      maxBudget: null,
      thinkingMode: 'adaptive',
      effort: 'low',
      hiddenProjects: null,
      updatedAt: '2026-04-18T00:00:00.000Z',
    }
    fakeDb.data.insert = [inserted]

    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', effort: 'low' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { preferences: Record<string, unknown> }
    expect(body.preferences).toEqual(inserted)
    expect(fakeDb.db.insert).toHaveBeenCalled()
  })

  it('rejects unknown fields with 400', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bogus: 'x' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Unknown field/)
  })

  it('rejects an invalid effort enum with 400', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'extreme' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Invalid effort/)
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

describe('PUT /api/preferences (chains + autoAdvance)', () => {
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

  it('persists chains:{…} by stringifying into chains_json', async () => {
    const inserted = {
      userId: 'user-1',
      permissionMode: 'default',
      model: 'claude-sonnet-4-20250514',
      maxBudget: null,
      thinkingMode: 'adaptive',
      effort: 'high',
      hiddenProjects: null,
      chainsJson: JSON.stringify({ '58': { autoAdvance: true } }),
      defaultChainAutoAdvance: false,
      updatedAt: '2026-04-22T00:00:00.000Z',
    }
    fakeDb.data.insert = [inserted]

    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chains: { '58': { autoAdvance: true, activeRung: 'implementation' } },
      }),
    })

    // `activeRung` is NOT in the server's allow-list — validator rejects it.
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Invalid chains shape/)
  })

  it('persists {chains:{"58":{autoAdvance:true}}} as chains_json', async () => {
    const inserted = {
      userId: 'user-1',
      permissionMode: 'default',
      model: 'claude-sonnet-4-20250514',
      maxBudget: null,
      thinkingMode: 'adaptive',
      effort: 'high',
      hiddenProjects: null,
      chainsJson: JSON.stringify({ '58': { autoAdvance: true } }),
      defaultChainAutoAdvance: false,
      updatedAt: '2026-04-22T00:00:00.000Z',
    }
    fakeDb.data.insert = [inserted]

    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chains: { '58': { autoAdvance: true } } }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { preferences: Record<string, unknown> }
    expect(body.preferences.chainsJson).toBe(JSON.stringify({ '58': { autoAdvance: true } }))
    expect(fakeDb.db.insert).toHaveBeenCalled()
  })

  it('rejects non-numeric chain keys with 400 "Invalid chain key"', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chains: { 'not-a-number': { autoAdvance: true } } }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Invalid chain key/)
  })

  it('persists defaultChainAutoAdvance:true', async () => {
    const inserted = {
      userId: 'user-1',
      permissionMode: 'default',
      model: 'claude-sonnet-4-20250514',
      maxBudget: null,
      thinkingMode: 'adaptive',
      effort: 'high',
      hiddenProjects: null,
      chainsJson: null,
      defaultChainAutoAdvance: true,
      updatedAt: '2026-04-22T00:00:00.000Z',
    }
    fakeDb.data.insert = [inserted]

    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultChainAutoAdvance: true }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { preferences: Record<string, unknown> }
    expect(body.preferences.defaultChainAutoAdvance).toBe(true)
  })

  it('rejects non-boolean defaultChainAutoAdvance with 400', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultChainAutoAdvance: 'yes' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/defaultChainAutoAdvance must be a boolean/)
  })

  it('GET /api/preferences roundtrips stored chains + defaultChainAutoAdvance', async () => {
    const stored = {
      userId: 'user-1',
      permissionMode: 'default',
      model: 'claude-sonnet-4-20250514',
      maxBudget: null,
      thinkingMode: 'adaptive',
      effort: 'high',
      hiddenProjects: null,
      chainsJson: JSON.stringify({ '58': { autoAdvance: true } }),
      defaultChainAutoAdvance: true,
      updatedAt: '2026-04-22T00:00:00.000Z',
    }
    fakeDb.data.select = [stored]

    const app = makeApp(env)
    const res = await app.request('/api/preferences')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.chainsJson).toBe(JSON.stringify({ '58': { autoAdvance: true } }))
    expect(body.defaultChainAutoAdvance).toBe(true)
  })
})
