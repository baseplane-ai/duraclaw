/**
 * GH#27 P1.6 WU-B: tests for `GET /api/projects/:projectId/docs-files`.
 *
 * Mirrors the harness pattern from project-metadata-api.test.ts /
 * project-hiding.test.ts: vi.mock the auth-session + drizzle-orm/d1
 * modules, stub `globalThis.fetch` per case, drive the route via the
 * Hono app's `fetch` with a synthetic Request.
 *
 * Coverage:
 *  1. no auth                              → 401
 *  2. no projectMetadata row               → 404 project_not_configured
 *  3. row exists but docsWorktreePath null → 404 project_not_configured
 *  4. gateway 200                          → 200, body forwarded
 *  5. fetch throws                         → 503 gateway_unavailable
 *  6. gateway 5xx                          → 502 gateway_error
 */

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

const VALID_PID = '0123456789abcdef'

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
    CC_GATEWAY_URL: 'https://gateway.test',
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

const authedSession = {
  userId: 'user-1',
  session: { id: 's' },
  user: { id: 'user-1' },
}

describe('GET /api/projects/:projectId/docs-files', () => {
  const originalFetch = globalThis.fetch
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockReset()
    mockedGetRequestSession.mockResolvedValue(authedSession as any)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('no auth → 401', async () => {
    mockedGetRequestSession.mockResolvedValue(null)
    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}/docs-files`)
    expect(res.status).toBe(401)
  })

  it('no projectMetadata row → 404 project_not_configured', async () => {
    fakeDb.data.queue.push([])
    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}/docs-files`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('project_not_configured')
  })

  it('row exists but docsWorktreePath is null → 404 project_not_configured', async () => {
    fakeDb.data.queue.push([
      {
        projectId: VALID_PID,
        projectName: 'duraclaw',
        originUrl: null,
        docsWorktreePath: null,
        tombstoneGraceDays: 7,
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
      },
    ])
    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}/docs-files`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('project_not_configured')
  })

  it('gateway 200 → forwards body and status', async () => {
    fakeDb.data.queue.push([
      {
        projectId: VALID_PID,
        projectName: 'duraclaw',
        originUrl: null,
        docsWorktreePath: '/data/docs',
        tombstoneGraceDays: 7,
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
      },
    ])

    const gatewayBody = {
      files: [{ relPath: 'README.md', lastModified: 1700000000000 }],
    }
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(gatewayBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchSpy as any

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}/docs-files`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(gatewayBody)

    // Confirms the proxy forms the right URL + auth header.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toContain(`/docs-runners/${VALID_PID}/files`)
    expect(calledUrl).toContain(`docsWorktreePath=${encodeURIComponent('/data/docs')}`)
    expect((calledInit.headers as Record<string, string>).Authorization).toBe('Bearer gw-secret')
  })

  it('fetch throws → 503 gateway_unavailable', async () => {
    fakeDb.data.queue.push([
      {
        projectId: VALID_PID,
        projectName: 'duraclaw',
        originUrl: null,
        docsWorktreePath: '/data/docs',
        tombstoneGraceDays: 7,
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
      },
    ])
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused')) as any

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}/docs-files`)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('gateway_unavailable')
  })

  it('gateway 5xx → 502 gateway_error', async () => {
    fakeDb.data.queue.push([
      {
        projectId: VALID_PID,
        projectName: 'duraclaw',
        originUrl: null,
        docsWorktreePath: '/data/docs',
        tombstoneGraceDays: 7,
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
      },
    ])
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 })) as any

    const app = makeApp(env)
    const res = await app.request(`/api/projects/${VALID_PID}/docs-files`)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; upstreamStatus: number }
    expect(body.error).toBe('gateway_error')
    expect(body.upstreamStatus).toBe(500)
  })
})
