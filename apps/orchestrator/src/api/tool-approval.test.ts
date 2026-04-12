import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateActionToken } from '~/lib/action-token'

const { mockGetRequestSession } = vi.hoisted(() => ({
  mockGetRequestSession: vi.fn(),
}))

vi.mock('./auth-session', () => ({
  getRequestSession: mockGetRequestSession,
}))

vi.mock('./auth-routes', () => {
  const { Hono } = require('hono')
  return { authRoutes: new Hono() }
})

vi.mock('~/lib/auth', () => ({
  createAuth: vi.fn(),
}))

import { createApiApp } from './index'

const TEST_SECRET = 'test-hmac-secret'

function createMockRegistry(overrides: Record<string, any> = {}) {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    listActiveSessions: vi.fn().mockResolvedValue([]),
    listSessionsByProject: vi.fn().mockResolvedValue([]),
    searchSessions: vi.fn().mockResolvedValue([]),
    listSessionsPaginated: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    ...overrides,
  }
}

function createMockSessionDO(fetchResponse?: Response) {
  return {
    fetch: vi.fn().mockResolvedValue(fetchResponse ?? new Response(JSON.stringify({ ok: true }))),
  }
}

function createMockEnv(
  registry: ReturnType<typeof createMockRegistry>,
  sessionDO?: ReturnType<typeof createMockSessionDO>,
) {
  return {
    SESSION_REGISTRY: {
      idFromName: vi.fn().mockReturnValue('registry-id'),
      get: vi.fn().mockReturnValue(registry),
    },
    SESSION_AGENT: {
      newUniqueId: vi.fn(),
      idFromString: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(sessionDO ?? createMockSessionDO()),
    },
    AUTH_DB: {} as any,
    BETTER_AUTH_SECRET: TEST_SECRET,
    ASSETS: {} as any,
  } as any
}

describe('POST /api/sessions/:id/tool-approval', () => {
  describe('with Bearer action token', () => {
    it('accepts a valid action token and forwards to DO', async () => {
      const sessionDO = createMockSessionDO()
      const registry = createMockRegistry()
      const env = createMockEnv(registry, sessionDO)

      const token = await generateActionToken('sess-1', 'gate-abc', TEST_SECRET)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ approved: true }),
        },
        env,
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })

      // Verify the DO fetch was called with the gid from the token
      expect(sessionDO.fetch).toHaveBeenCalledOnce()
      const fetchCall = sessionDO.fetch.mock.calls[0][0] as Request
      const body = await fetchCall.json()
      expect(body.approved).toBe(true)
      expect(body.toolCallId).toBe('gate-abc')
    })

    it('passes approved:false for deny action', async () => {
      const sessionDO = createMockSessionDO()
      const registry = createMockRegistry()
      const env = createMockEnv(registry, sessionDO)

      const token = await generateActionToken('sess-1', 'gate-abc', TEST_SECRET)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ approved: false }),
        },
        env,
      )

      expect(res.status).toBe(200)
      const fetchCall = sessionDO.fetch.mock.calls[0][0] as Request
      const body = await fetchCall.json()
      expect(body.approved).toBe(false)
    })

    it('rejects an invalid action token with 401', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer invalid.token',
          },
          body: JSON.stringify({ approved: true }),
        },
        env,
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid token' })
    })

    it('rejects a token signed with a different secret', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry)

      const token = await generateActionToken('sess-1', 'gate-abc', 'wrong-secret')

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ approved: true }),
        },
        env,
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Invalid token' })
    })

    it('rejects a token for a different session ID', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry)

      const token = await generateActionToken('sess-OTHER', 'gate-abc', TEST_SECRET)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ approved: true }),
        },
        env,
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Token session mismatch' })
    })

    it('rejects an expired action token', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry)

      // Generate token with exp in the past
      const realDateNow = Date.now
      vi.spyOn(Date, 'now').mockReturnValue((Math.floor(realDateNow() / 1000) - 600) * 1000)
      const token = await generateActionToken('sess-1', 'gate-abc', TEST_SECRET)
      vi.restoreAllMocks()

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ approved: true }),
        },
        env,
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Token expired' })
    })

    it('does not require session cookie auth when Bearer token is valid', async () => {
      // Ensure getRequestSession is NOT called when Bearer token is used
      mockGetRequestSession.mockResolvedValue(null) // would fail if checked

      const sessionDO = createMockSessionDO()
      const registry = createMockRegistry()
      const env = createMockEnv(registry, sessionDO)

      const token = await generateActionToken('sess-1', 'gate-abc', TEST_SECRET)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ approved: true }),
        },
        env,
      )

      expect(res.status).toBe(200)
      expect(mockGetRequestSession).not.toHaveBeenCalled()
    })
  })

  describe('with session cookie auth (no Bearer token)', () => {
    it('accepts a valid session and forwards to DO', async () => {
      mockGetRequestSession.mockResolvedValue({
        userId: 'user-1',
        session: {},
        user: {},
      })

      const sessionDO = createMockSessionDO()
      const registry = createMockRegistry({
        getSession: vi.fn().mockResolvedValue({
          id: 'sess-1',
          userId: 'user-1',
          project: 'test',
          status: 'waiting_gate',
        }),
      })
      const env = createMockEnv(registry, sessionDO)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true, toolCallId: 'gate-xyz' }),
        },
        env,
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(mockGetRequestSession).toHaveBeenCalled()
    })

    it('returns 401 when not authenticated and no Bearer token', async () => {
      mockGetRequestSession.mockResolvedValue(null)

      const registry = createMockRegistry()
      const env = createMockEnv(registry)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true, toolCallId: 'gate-xyz' }),
        },
        env,
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    })

    it('returns 404 when session not found in registry', async () => {
      mockGetRequestSession.mockResolvedValue({
        userId: 'user-1',
        session: {},
        user: {},
      })

      const registry = createMockRegistry({
        getSession: vi.fn().mockResolvedValue(null),
      })
      const env = createMockEnv(registry)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true, toolCallId: 'gate-xyz' }),
        },
        env,
      )

      expect(res.status).toBe(404)
    })

    it('returns 403 when session belongs to another user', async () => {
      mockGetRequestSession.mockResolvedValue({
        userId: 'user-1',
        session: {},
        user: {},
      })

      const registry = createMockRegistry({
        getSession: vi.fn().mockResolvedValue({
          id: 'sess-1',
          userId: 'user-OTHER',
          project: 'test',
          status: 'waiting_gate',
        }),
      })
      const env = createMockEnv(registry)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true, toolCallId: 'gate-xyz' }),
        },
        env,
      )

      expect(res.status).toBe(403)
    })

    it('returns 400 when toolCallId is missing for cookie auth', async () => {
      mockGetRequestSession.mockResolvedValue({
        userId: 'user-1',
        session: {},
        user: {},
      })

      const registry = createMockRegistry({
        getSession: vi.fn().mockResolvedValue({
          id: 'sess-1',
          userId: 'user-1',
          project: 'test',
          status: 'waiting_gate',
        }),
      })
      const env = createMockEnv(registry)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        },
        env,
      )

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid tool approval payload' })
    })
  })

  describe('common validation', () => {
    it('returns 400 when approved field is missing', async () => {
      const registry = createMockRegistry()
      const env = createMockEnv(registry)

      const app = createApiApp()
      const res = await app.request(
        '/api/sessions/sess-1/tool-approval',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId: 'gate-xyz' }),
        },
        env,
      )

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid tool approval payload' })
    })
  })
})
