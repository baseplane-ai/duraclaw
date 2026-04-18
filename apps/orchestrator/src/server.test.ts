import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from './lib/types'

// Mock auth-session before importing the module under test
vi.mock('./api/auth-session', () => ({
  getRequestSession: vi.fn(),
}))

// Mock the API app (module-level createApiApp call)
vi.mock('./api', () => ({
  createApiApp: () => ({
    fetch: vi.fn(() => new Response('api')),
  }),
}))

// Mock DO classes to avoid import side-effects
vi.mock('./agents/project-registry', () => ({
  ProjectRegistry: class {},
}))
vi.mock('./agents/session-do', () => ({
  SessionDO: class {},
}))
vi.mock('./agents/user-settings-do', () => ({
  UserSettingsDO: class {},
}))
vi.mock('./agents/session-collab-do', () => ({
  SessionCollabDO: class {},
}))

// partyserver imports `cloudflare:workers` which the node ESM loader
// can't resolve. Stub the only export server.ts uses.
vi.mock('partyserver', () => ({
  routePartykitRequest: vi.fn().mockResolvedValue(null),
}))

import { getRequestSession } from './api/auth-session'
import serverExport from './server'

const mockedGetRequestSession = vi.mocked(getRequestSession)

function createMockEnv(overrides?: Partial<Env>) {
  const mockStubFetch = vi.fn(() => new Response('ws-upgraded', { status: 101 }))
  const mockStub = { fetch: mockStubFetch }
  const mockDoId = { toString: () => 'mock-do-id' }

  const env = {
    SESSION_AGENT: {
      idFromName: vi.fn(() => mockDoId),
      idFromString: vi.fn(() => mockDoId),
      get: vi.fn(() => mockStub),
    },
    SESSION_REGISTRY: {},
    ASSETS: {
      fetch: vi.fn(() => new Response('asset', { status: 200 })),
    },
    AUTH_DB: {},
    BETTER_AUTH_SECRET: 'test-secret',
    ...overrides,
  } as unknown as Env

  return { env, mockStub, mockStubFetch, mockDoId }
}

function createWsRequest(path: string, headers?: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    headers: {
      Upgrade: 'websocket',
      ...headers,
    },
  })
}

const mockCtx = {} as ExecutionContext

describe('server WS upgrade handler', () => {
  beforeEach(() => {
    mockedGetRequestSession.mockReset()
  })

  describe('browser auth (no role param)', () => {
    it('returns 401 when no authenticated session', async () => {
      mockedGetRequestSession.mockResolvedValue(null)
      const { env } = createMockEnv()

      const request = createWsRequest('/api/sessions/test-session/ws')
      const response = await serverExport.fetch(request, env, mockCtx)

      expect(response.status).toBe(401)
      expect(await response.text()).toBe('Unauthorized')
    })

    it('forwards to DO with x-user-id and x-partykit-room when authenticated', async () => {
      mockedGetRequestSession.mockResolvedValue({
        userId: 'user-42',
        role: 'user',
        session: {},
        user: {},
      })
      const { env, mockStubFetch } = createMockEnv()

      const request = createWsRequest('/api/sessions/my-session/ws')
      await serverExport.fetch(request, env, mockCtx)

      expect(mockStubFetch).toHaveBeenCalledOnce()
      const forwardedRequest = mockStubFetch.mock.calls[0][0] as Request
      expect(forwardedRequest.headers.get('x-user-id')).toBe('user-42')
      expect(forwardedRequest.headers.get('x-partykit-room')).toBe('my-session')
      expect(forwardedRequest.headers.get('x-gateway-token')).toBeNull()
    })

    it('does not set x-gateway-token for browser auth', async () => {
      mockedGetRequestSession.mockResolvedValue({
        userId: 'user-1',
        role: 'user',
        session: {},
        user: {},
      })
      const { env, mockStubFetch } = createMockEnv()

      const request = createWsRequest('/api/sessions/s1/ws')
      await serverExport.fetch(request, env, mockCtx)

      const forwardedRequest = mockStubFetch.mock.calls[0][0] as Request
      expect(forwardedRequest.headers.get('x-gateway-token')).toBeNull()
    })
  })

  describe('gateway auth (role=gateway)', () => {
    it('skips getRequestSession and forwards with x-gateway-token', async () => {
      const { env, mockStubFetch } = createMockEnv()

      const request = createWsRequest('/api/sessions/my-session/ws?role=gateway&token=secret-tok')
      await serverExport.fetch(request, env, mockCtx)

      // Must NOT call Better Auth
      expect(mockedGetRequestSession).not.toHaveBeenCalled()

      expect(mockStubFetch).toHaveBeenCalledOnce()
      const forwardedRequest = mockStubFetch.mock.calls[0][0] as Request
      expect(forwardedRequest.headers.get('x-gateway-token')).toBe('secret-tok')
      expect(forwardedRequest.headers.get('x-partykit-room')).toBe('my-session')
    })

    it('does not set x-user-id for gateway connections', async () => {
      const { env, mockStubFetch } = createMockEnv()

      const request = createWsRequest('/api/sessions/sess-1/ws?role=gateway&token=tok')
      await serverExport.fetch(request, env, mockCtx)

      const forwardedRequest = mockStubFetch.mock.calls[0][0] as Request
      expect(forwardedRequest.headers.get('x-user-id')).toBeNull()
    })

    it('passes empty string when no token param', async () => {
      const { env, mockStubFetch } = createMockEnv()

      const request = createWsRequest('/api/sessions/sess-1/ws?role=gateway')
      await serverExport.fetch(request, env, mockCtx)

      const forwardedRequest = mockStubFetch.mock.calls[0][0] as Request
      expect(forwardedRequest.headers.get('x-gateway-token')).toBe('')
    })
  })

  describe('session ID handling', () => {
    it('uses idFromName for non-hex session IDs', async () => {
      mockedGetRequestSession.mockResolvedValue({
        userId: 'u1',
        role: 'user',
        session: {},
        user: {},
      })
      const { env } = createMockEnv()

      const request = createWsRequest('/api/sessions/my-named-session/ws')
      await serverExport.fetch(request, env, mockCtx)

      expect((env.SESSION_AGENT as any).idFromName).toHaveBeenCalledWith('my-named-session')
      expect((env.SESSION_AGENT as any).idFromString).not.toHaveBeenCalled()
    })

    it('uses idFromString for 64-char hex session IDs', async () => {
      const hexId = 'a'.repeat(64)
      mockedGetRequestSession.mockResolvedValue({
        userId: 'u1',
        role: 'user',
        session: {},
        user: {},
      })
      const { env } = createMockEnv()

      const request = createWsRequest(`/api/sessions/${hexId}/ws`)
      await serverExport.fetch(request, env, mockCtx)

      expect((env.SESSION_AGENT as any).idFromString).toHaveBeenCalledWith(hexId)
      expect((env.SESSION_AGENT as any).idFromName).not.toHaveBeenCalled()
    })

    it('returns 400 for invalid session IDs that throw', async () => {
      const { env } = createMockEnv()
      ;(env.SESSION_AGENT as any).idFromName.mockImplementation(() => {
        throw new Error('bad id')
      })

      const request = createWsRequest('/api/sessions/bad-id/ws?role=gateway&token=t')
      const response = await serverExport.fetch(request, env, mockCtx)

      expect(response.status).toBe(400)
      expect(await response.text()).toBe('Invalid session ID')
    })
  })

  describe('route matching', () => {
    it('matches /agents/session-agent/:id path', async () => {
      const { env, mockStubFetch } = createMockEnv()

      const request = createWsRequest('/agents/session-agent/sess-1?role=gateway&token=tok')
      await serverExport.fetch(request, env, mockCtx)

      expect(mockStubFetch).toHaveBeenCalledOnce()
      const forwardedRequest = mockStubFetch.mock.calls[0][0] as Request
      expect(forwardedRequest.headers.get('x-partykit-room')).toBe('sess-1')
    })
  })
})
