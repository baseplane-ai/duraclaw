import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '~/lib/types'

const { mockGetRequestSession } = vi.hoisted(() => ({
  mockGetRequestSession: vi.fn(),
}))

// Mock auth-session so authMiddleware always succeeds with a test userId
vi.mock('./auth-session', () => ({
  getRequestSession: mockGetRequestSession,
}))

// Mock auth-routes to avoid pulling in Better Auth
vi.mock('./auth-routes', () => {
  const { Hono } = require('hono')
  return { authRoutes: new Hono() }
})

// Mock ~/lib/auth (transitive dep)
vi.mock('~/lib/auth', () => ({
  createAuth: vi.fn(),
}))

import { createApiApp } from './index'

const authedSession = {
  userId: 'test-user-123',
  session: {},
  user: {},
}

beforeEach(() => {
  mockGetRequestSession.mockReset()
  mockGetRequestSession.mockResolvedValue(authedSession)
})

function mockD1() {
  const run = vi.fn().mockResolvedValue({ success: true })
  const bind = vi.fn().mockReturnValue({ run })
  const prepare = vi.fn().mockReturnValue({ bind })
  return { prepare, bind, run }
}

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION_AGENT: {} as any,
    SESSION_REGISTRY: {} as any,
    ASSETS: {} as any,
    AUTH_DB: mockD1() as any,
    BETTER_AUTH_SECRET: 'test-secret',
    VAPID_PUBLIC_KEY: 'test-vapid-public-key-base64',
    ...overrides,
  }
}

describe('GET /api/push/vapid-key', () => {
  it('returns the VAPID public key', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request('/api/push/vapid-key', {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: 'test-vapid-public-key-base64' })
  })

  it('returns 503 when VAPID_PUBLIC_KEY is not set', async () => {
    const app = createApiApp()
    const env = createMockEnv({ VAPID_PUBLIC_KEY: undefined })

    const res = await app.request('/api/push/vapid-key', {}, env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Push not configured' })
  })

  it('does not require authentication', async () => {
    // Make auth return null (unauthenticated)
    mockGetRequestSession.mockResolvedValue(null)

    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request('/api/push/vapid-key', {}, env)
    // Should still succeed — this endpoint is before auth middleware
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: 'test-vapid-public-key-base64' })
  })
})

describe('POST /api/push/subscribe', () => {
  const validBody = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: {
      p256dh: 'BNcRd...',
      auth: 'tBHI...',
    },
  }

  it('stores a subscription and returns 201', async () => {
    const app = createApiApp()
    const env = createMockEnv()
    const db = env.AUTH_DB as unknown as ReturnType<typeof mockD1>

    const res = await app.request(
      '/api/push/subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      env,
    )

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.prepare).toHaveBeenCalledOnce()
    expect(db.bind).toHaveBeenCalledWith(
      'test-user-123',
      validBody.endpoint,
      expect.any(String), // generated UUID
      'test-user-123',
      validBody.endpoint,
      validBody.keys.p256dh,
      validBody.keys.auth,
      null, // user-agent (not set in test)
    )
    expect(db.run).toHaveBeenCalledOnce()
  })

  it('returns 400 when endpoint is missing', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: { p256dh: 'x', auth: 'y' } }),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'Missing required fields: endpoint, keys.p256dh, keys.auth',
    })
  })

  it('returns 400 when keys are missing', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://example.com/push' }),
      },
      env,
    )

    expect(res.status).toBe(400)
  })

  it('returns 400 when p256dh key is missing', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'https://example.com/push',
          keys: { auth: 'y' },
        }),
      },
      env,
    )

    expect(res.status).toBe(400)
  })

  it('returns 400 for an invalid endpoint URL', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'not-a-url',
          keys: { p256dh: 'x', auth: 'y' },
        }),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid endpoint URL' })
  })
})

describe('POST /api/push/unsubscribe', () => {
  it('deletes the subscription and returns 204', async () => {
    const app = createApiApp()
    const env = createMockEnv()
    const db = env.AUTH_DB as unknown as ReturnType<typeof mockD1>

    const res = await app.request(
      '/api/push/unsubscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' }),
      },
      env,
    )

    expect(res.status).toBe(204)
    expect(db.prepare).toHaveBeenCalledOnce()
    expect(db.bind).toHaveBeenCalledWith(
      'test-user-123',
      'https://fcm.googleapis.com/fcm/send/abc123',
    )
    expect(db.run).toHaveBeenCalledOnce()
  })

  it('returns 400 when endpoint is missing', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/unsubscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing required field: endpoint' })
  })
})
