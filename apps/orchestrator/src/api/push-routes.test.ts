import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '~/lib/types'

const { mockGetRequestSession, mockSendPushNotification } = vi.hoisted(() => ({
  mockGetRequestSession: vi.fn(),
  mockSendPushNotification: vi.fn(),
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

// Mock web-push sender so /api/debug/push tests don't hit real endpoints
vi.mock('~/lib/push', () => ({
  sendPushNotification: mockSendPushNotification,
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
  mockSendPushNotification.mockReset()
  mockSendPushNotification.mockResolvedValue({ ok: true, status: 201 })
})

function mockD1() {
  const run = vi.fn().mockResolvedValue({ success: true })
  const all = vi.fn().mockResolvedValue({ results: [] })
  const bind = vi.fn().mockReturnValue({ run, all })
  const prepare = vi.fn().mockReturnValue({ bind })
  return { prepare, bind, run, all }
}

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION_AGENT: {} as any,
    SESSION_REGISTRY: {} as any,
    ASSETS: {} as any,
    AUTH_DB: mockD1() as any,
    BETTER_AUTH_SECRET: 'test-secret',
    VAPID_PUBLIC_KEY: 'test-vapid-public-key-base64',
    VAPID_PRIVATE_KEY: 'test-vapid-private-key',
    VAPID_SUBJECT: 'mailto:test@example.com',
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

describe('POST /api/debug/push', () => {
  function mockD1WithSubs(
    subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>,
  ) {
    const run = vi.fn().mockResolvedValue({ success: true })
    const all = vi.fn().mockResolvedValue({ results: subs })
    const bind = vi.fn().mockReturnValue({ run, all })
    const prepare = vi.fn().mockReturnValue({ bind })
    return { prepare, bind, run, all }
  }

  const FAKE_SUB = {
    id: 'sub-1',
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    p256dh: 'BNcRd...',
    auth: 'tBHI...',
  }

  it('sends a debug push with auto-generated URL from sessionId', async () => {
    const env = createMockEnv()
    env.AUTH_DB = mockD1WithSubs([FAKE_SUB]) as any
    const app = createApiApp()

    const res = await app.request(
      '/api/debug/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc-123' }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { sent: number; results: unknown[]; payload: unknown }
    expect(body.sent).toBe(1)
    expect(body.results).toHaveLength(1)
    expect(body.payload).toMatchObject({
      title: 'Duraclaw debug',
      url: '/?session=abc-123',
      tag: 'debug-push',
      sessionId: 'abc-123',
    })
    expect(mockSendPushNotification).toHaveBeenCalledOnce()
    expect(mockSendPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: FAKE_SUB.endpoint }),
      expect.objectContaining({ url: '/?session=abc-123' }),
      expect.objectContaining({ subject: 'mailto:test@example.com' }),
    )
  })

  it('uses an explicit url over sessionId when both provided', async () => {
    const env = createMockEnv()
    env.AUTH_DB = mockD1WithSubs([FAKE_SUB]) as any
    const app = createApiApp()

    const res = await app.request(
      '/api/debug/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ignored', url: '/custom/path?x=1' }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { payload: { url: string } }
    expect(body.payload.url).toBe('/custom/path?x=1')
  })

  it('accepts title, body, tag, and actions overrides', async () => {
    const env = createMockEnv()
    env.AUTH_DB = mockD1WithSubs([FAKE_SUB]) as any
    const app = createApiApp()

    const customActions = [
      { action: 'approve', title: 'Yes' },
      { action: 'deny', title: 'No' },
    ]
    const res = await app.request(
      '/api/debug/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 's1',
          title: 'Custom title',
          body: 'Custom body',
          tag: 'custom-tag',
          actions: customActions,
        }),
      },
      env,
    )

    const body = (await res.json()) as {
      payload: { title: string; body: string; tag: string; actions: unknown }
    }
    expect(body.payload).toMatchObject({
      title: 'Custom title',
      body: 'Custom body',
      tag: 'custom-tag',
      actions: customActions,
    })
  })

  it('returns 404 when the user has no push subscriptions', async () => {
    const env = createMockEnv()
    env.AUTH_DB = mockD1WithSubs([]) as any
    const app = createApiApp()

    const res = await app.request(
      '/api/debug/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc' }),
      },
      env,
    )

    expect(res.status).toBe(404)
    expect(mockSendPushNotification).not.toHaveBeenCalled()
  })

  it('returns 500 when VAPID is not configured', async () => {
    const env = createMockEnv({ VAPID_PUBLIC_KEY: undefined })
    env.AUTH_DB = mockD1WithSubs([FAKE_SUB]) as any
    const app = createApiApp()

    const res = await app.request(
      '/api/debug/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc' }),
      },
      env,
    )

    expect(res.status).toBe(500)
    expect(mockSendPushNotification).not.toHaveBeenCalled()
  })

  it('prunes subscriptions that return 410 Gone', async () => {
    const env = createMockEnv()
    const db = mockD1WithSubs([FAKE_SUB])
    env.AUTH_DB = db as any
    mockSendPushNotification.mockResolvedValue({ ok: false, status: 410, gone: true })
    const app = createApiApp()

    const res = await app.request(
      '/api/debug/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc' }),
      },
      env,
    )

    expect(res.status).toBe(200)
    // First prepare = SELECT subs, second prepare = DELETE gone sub
    expect(db.prepare).toHaveBeenCalledTimes(2)
    expect(db.prepare.mock.calls[1][0]).toContain('DELETE FROM push_subscriptions')
    expect(db.bind).toHaveBeenLastCalledWith('sub-1')
  })

  it('fans out to multiple subscriptions', async () => {
    const env = createMockEnv()
    const subs = [
      { id: 'sub-1', endpoint: 'https://fcm.googleapis.com/fcm/send/a', p256dh: 'x', auth: 'y' },
      {
        id: 'sub-2',
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/b',
        p256dh: 'x',
        auth: 'y',
      },
      { id: 'sub-3', endpoint: 'https://web.push.apple.com/c', p256dh: 'x', auth: 'y' },
    ]
    env.AUTH_DB = mockD1WithSubs(subs) as any
    const app = createApiApp()

    const res = await app.request(
      '/api/debug/push',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc' }),
      },
      env,
    )

    const body = (await res.json()) as { sent: number; results: unknown[] }
    expect(res.status).toBe(200)
    expect(body.sent).toBe(3)
    expect(body.results).toHaveLength(3)
    expect(mockSendPushNotification).toHaveBeenCalledTimes(3)
  })
})
