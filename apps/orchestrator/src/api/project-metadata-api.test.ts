/**
 * GH#27 P1.1 (B2): tests for `PATCH /api/projects/:projectId` and
 * `GET /api/projects/:projectId`.
 *
 * Mirrors the harness pattern from preferences-api.test.ts /
 * sessions-api.test.ts: vi.mock the auth-session + drizzle-orm/d1
 * modules, then drive the route via the Hono app's `fetch` with a
 * synthetic Request.
 *
 * Coverage:
 *  1. PATCH cookie + missing row    → insert, 200, body matches
 *  2. PATCH cookie + existing row   → merge, createdAt unchanged, updatedAt advanced
 *  3. PATCH valid bearer            → succeeds (no cookie required)
 *  4. PATCH wrong bearer            → 401
 *  5. PATCH no auth                 → 401
 *  6. PATCH bad projectId           → 400
 *  7. PATCH tombstoneGraceDays:-1   → 400
 *  8. GET cookie + existing row     → 200 with row
 *  9. GET cookie + missing row      → 404
 * 10. GET valid bearer              → 200
 * 11. GET no auth                   → 401
 */

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

const VALID_PID = '0123456789abcdef'
const DOCS_SECRET = 'docs-secret-test'

function createMockEnv(overrides: Record<string, unknown> = {}) {
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
    DOCS_RUNNER_SECRET: DOCS_SECRET,
    ASSETS: {},
    ...overrides,
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

// GH#122 P1.3: PATCH/GET /api/projects/:projectId now go through
// `requireProjectMember`. Use an admin session so these focused tests
// (which target validation + insert/update behavior, not the membership
// gate itself) bypass the project_members lookup. The membership gate's
// own behavior is covered by `middleware/require-project-member.test.ts`.
const authedSession = {
  userId: 'user-1',
  role: 'admin',
  session: { id: 's' },
  user: { id: 'user-1', role: 'admin' },
}

describe('PATCH /api/projects/:projectId', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockReset()
    mockedGetRequestSession.mockResolvedValue(authedSession as any)
  })

  it('cookie + missing row → inserts and returns the new row (200)', async () => {
    const inserted = {
      projectId: VALID_PID,
      projectName: 'duraclaw',
      originUrl: 'git@github.com:foo/duraclaw.git',
      docsWorktreePath: null,
      tombstoneGraceDays: 7,
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z',
    }
    // First read: no existing row. Then insert returns the inserted row.
    fakeDb.data.queue.push([])
    fakeDb.data.queue.push([inserted])

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: 'duraclaw',
        originUrl: 'git@github.com:foo/duraclaw.git',
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(inserted)
    expect(fakeDb.db.insert).toHaveBeenCalled()
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('cookie + existing row → merges, createdAt unchanged, updatedAt advanced', async () => {
    const existing = {
      projectId: VALID_PID,
      projectName: 'duraclaw',
      originUrl: 'git@github.com:foo/duraclaw.git',
      docsWorktreePath: null,
      tombstoneGraceDays: 7,
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    }
    const updated = {
      ...existing,
      docsWorktreePath: '/data/docs',
      // updatedAt advanced — set by the handler, not the test stub.
      updatedAt: '2026-04-27T12:00:00.000Z',
    }
    // Read: existing row. Update: returns merged row.
    fakeDb.data.queue.push([existing])
    fakeDb.data.queue.push([updated])

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docsWorktreePath: '/data/docs' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.docsWorktreePath).toBe('/data/docs')
    expect(body.createdAt).toBe('2026-04-20T00:00:00.000Z')
    expect(body.updatedAt).not.toBe('2026-04-20T00:00:00.000Z')
    expect(fakeDb.db.update).toHaveBeenCalled()
    expect(fakeDb.db.insert).not.toHaveBeenCalled()
  })

  it('valid bearer (no cookie) → succeeds', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const inserted = {
      projectId: VALID_PID,
      projectName: VALID_PID,
      originUrl: null,
      docsWorktreePath: null,
      tombstoneGraceDays: 7,
      createdAt: '2026-04-27T00:00:00.000Z',
      updatedAt: '2026-04-27T00:00:00.000Z',
    }
    fakeDb.data.queue.push([])
    fakeDb.data.queue.push([inserted])

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DOCS_SECRET}`,
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    // Bearer path skips cookie-auth lookup entirely.
    expect(mockedGetRequestSession).not.toHaveBeenCalled()
  })

  it('wrong bearer → 401', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-the-real-secret',
      },
      body: JSON.stringify({ projectName: 'x' }),
    })
    expect(res.status).toBe(401)
    // Bearer-shaped header → no cookie fallback (avoids userId enumeration).
    expect(mockedGetRequestSession).not.toHaveBeenCalled()
  })

  it('no cookie + no bearer → 401', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('invalid projectId (not 16 hex) → 400', async () => {
    const app = makeApp(env)
    // Too short, mixed case, non-hex chars — all rejected.
    for (const bad of ['short', '0123456789ABCDEF', '0123456789abcdeg', 'g'.repeat(16)]) {
      const res = await app.request(`/api/projects/${bad}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: 'x' }),
      })
      expect(res.status).toBe(400)
    }
  })

  it('tombstoneGraceDays: -1 → 400', async () => {
    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tombstoneGraceDays: -1 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/tombstoneGraceDays/)
  })
})

describe('GET /api/projects/:projectId', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockReset()
    mockedGetRequestSession.mockResolvedValue(authedSession as any)
  })

  it('cookie + existing row → 200 with row', async () => {
    const row = {
      projectId: VALID_PID,
      projectName: 'duraclaw',
      originUrl: null,
      docsWorktreePath: '/data/docs',
      tombstoneGraceDays: 7,
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    }
    fakeDb.data.queue.push([row])

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(row)
  })

  it('cookie + missing row → 404', async () => {
    fakeDb.data.queue.push([])

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`)
    expect(res.status).toBe(404)
  })

  it('valid bearer → 200', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const row = {
      projectId: VALID_PID,
      projectName: 'duraclaw',
      originUrl: null,
      docsWorktreePath: null,
      tombstoneGraceDays: 7,
      createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z',
    }
    fakeDb.data.queue.push([row])

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`, {
      headers: { Authorization: `Bearer ${DOCS_SECRET}` },
    })
    expect(res.status).toBe(200)
    expect(mockedGetRequestSession).not.toHaveBeenCalled()
  })

  it('no auth → 401', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}`)
    expect(res.status).toBe(401)
  })

  it('invalid projectId (GET) → 400', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/projects/short')
    expect(res.status).toBe(400)
  })
})
