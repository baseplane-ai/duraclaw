import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '~/lib/types'

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

vi.mock('~/lib/push', () => ({
  sendPushNotification: vi.fn(),
}))

import { createApiApp } from './index'

const authedSession = {
  userId: 'test-user-fcm',
  session: {},
  user: {},
}

beforeEach(() => {
  mockGetRequestSession.mockReset()
  mockGetRequestSession.mockResolvedValue(authedSession)
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
    USER_SETTINGS: {} as any,
    ASSETS: {} as any,
    AUTH_DB: mockD1() as any,
    BETTER_AUTH_SECRET: 'test-secret',
    ...overrides,
  }
}

describe('POST /api/push/fcm-subscribe', () => {
  it('inserts an FCM token row and returns 201', async () => {
    const app = createApiApp()
    const env = createMockEnv()
    const db = env.AUTH_DB as unknown as ReturnType<typeof mockD1>

    const res = await app.request(
      '/api/push/fcm-subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fcm-tok-1', platform: 'android' }),
      },
      env,
    )

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    expect(db.prepare).toHaveBeenCalledOnce()
    // INSERT OR REPLACE binds: token, userId (for COALESCE select), id, userId, token, platform
    expect(db.bind).toHaveBeenCalledWith(
      'fcm-tok-1',
      'test-user-fcm',
      expect.any(String),
      'test-user-fcm',
      'fcm-tok-1',
      'android',
    )
    expect(db.run).toHaveBeenCalledOnce()
  })

  it('defaults platform to android when omitted', async () => {
    const app = createApiApp()
    const env = createMockEnv()
    const db = env.AUTH_DB as unknown as ReturnType<typeof mockD1>

    const res = await app.request(
      '/api/push/fcm-subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fcm-tok-2' }),
      },
      env,
    )

    expect(res.status).toBe(201)
    const lastBind = db.bind.mock.calls[0]
    expect(lastBind[5]).toBe('android')
  })

  it('upserts when same token re-registered for same user (preserves id)', async () => {
    // The COALESCE pattern keeps the existing id when (token, user) match.
    // We can't easily inspect SQL semantics in mock, but we can verify the
    // SQL string and bind shape are correct.
    const app = createApiApp()
    const env = createMockEnv()
    const db = env.AUTH_DB as unknown as ReturnType<typeof mockD1>

    await app.request(
      '/api/push/fcm-subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fcm-tok-3', platform: 'android' }),
      },
      env,
    )

    const sql = db.prepare.mock.calls[0][0] as string
    expect(sql).toContain('INSERT OR REPLACE INTO fcm_subscriptions')
    expect(sql).toContain('COALESCE')
  })

  it('reassigns ownership when token belongs to different user (token rotation)', async () => {
    // INSERT OR REPLACE on the unique token index handles cross-user rotation.
    // Verify the query relies on the unique token index (no user_id in
    // COALESCE-find when token would conflict cross-user).
    const app = createApiApp()
    const env = createMockEnv()
    const db = env.AUTH_DB as unknown as ReturnType<typeof mockD1>

    await app.request(
      '/api/push/fcm-subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'cross-user-tok' }),
      },
      env,
    )

    // The bound user_id is the new owner (from auth) — the unique token
    // index causes the prior cross-user row to be replaced.
    expect(db.bind.mock.calls[0][1]).toBe('test-user-fcm')
    expect(db.bind.mock.calls[0][3]).toBe('test-user-fcm')
  })

  it('returns 400 when token is missing', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/fcm-subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing required field: token' })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetRequestSession.mockResolvedValue(null)
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/fcm-subscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'x' }),
      },
      env,
    )

    expect(res.status).toBe(401)
  })
})

describe('POST /api/push/fcm-unsubscribe', () => {
  it('deletes the FCM subscription and returns 204', async () => {
    const app = createApiApp()
    const env = createMockEnv()
    const db = env.AUTH_DB as unknown as ReturnType<typeof mockD1>

    const res = await app.request(
      '/api/push/fcm-unsubscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fcm-tok-rm' }),
      },
      env,
    )

    expect(res.status).toBe(204)
    expect(db.prepare).toHaveBeenCalledOnce()
    expect(db.bind).toHaveBeenCalledWith('test-user-fcm', 'fcm-tok-rm')
    expect(db.run).toHaveBeenCalledOnce()
  })

  it('returns 400 when token is missing', async () => {
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/fcm-unsubscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing required field: token' })
  })

  it('returns 401 when unauthenticated', async () => {
    mockGetRequestSession.mockResolvedValue(null)
    const app = createApiApp()
    const env = createMockEnv()

    const res = await app.request(
      '/api/push/fcm-unsubscribe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'x' }),
      },
      env,
    )

    expect(res.status).toBe(401)
  })
})
