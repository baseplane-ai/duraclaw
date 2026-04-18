// Cross-cutting test for spec test case `invalidation-fires`:
// every mutation endpoint that returns 2xx must call notifyInvalidation
// exactly once with the correct collection name. We spy on the helper
// (vi.mock('./notify')) rather than observing the DO POST — the DO-side
// /notify handler lives in p3.

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

vi.mock('./notify', () => ({
  notifyInvalidation: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { createApiApp } from './index'
import { notifyInvalidation } from './notify'

const mockedGetRequestSession = vi.mocked(getRequestSession)
const mockedNotify = vi.mocked(notifyInvalidation)

function createMockEnv() {
  return {
    SESSION_AGENT: {
      newUniqueId: vi.fn().mockReturnValue({ toString: () => 'new-do-id' }),
      idFromString: vi.fn().mockReturnValue('do-id'),
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ok: true, session_id: 'do-123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      }),
    },
    USER_SETTINGS: {
      idFromName: vi.fn().mockReturnValue('settings-id'),
      get: vi.fn().mockReturnValue({ fetch: vi.fn().mockResolvedValue(new Response(null)) }),
    },
    AUTH_DB: {},
    BETTER_AUTH_SECRET: 'test-secret',
    ASSETS: {},
    CC_GATEWAY_URL: 'wss://gateway.test',
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

describe('notifyInvalidation fires once per mutation endpoint', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    mockedNotify.mockClear()
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-1',
      session: { id: 's' },
      user: { id: 'user-1' },
    })
  })

  it('POST /api/sessions calls notify with agent_sessions', async () => {
    fakeDb.data.insert = [{}]
    const app = makeApp(env)
    const res = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'p', prompt: 'hi' }),
    })
    expect(res.status).toBe(201)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'agent_sessions')
  })

  it('PATCH /api/sessions/:id calls notify with agent_sessions', async () => {
    // PATCH does an update; .returning() on success.
    fakeDb.data.update = [{ id: 'sess-1', userId: 'user-1' }]
    const app = makeApp(env)
    const res = await app.request('/api/sessions/sess-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'new title' }),
    })
    expect(res.status).toBe(200)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'agent_sessions')
  })

  it('PATCH /api/sessions/:id does NOT call notify on 404', async () => {
    fakeDb.data.update = []
    const app = makeApp(env)
    const res = await app.request('/api/sessions/sess-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'new title' }),
    })
    expect(res.status).toBe(404)
    expect(mockedNotify).not.toHaveBeenCalled()
  })

  it('POST /api/sessions/sync calls notify with agent_sessions', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const app = makeApp(env)
    const res = await app.request('/api/sessions/sync', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'agent_sessions')

    globalThis.fetch = originalFetch
  })

  it('POST /api/user-settings/tabs calls notify with user_tabs', async () => {
    fakeDb.data.queue.push([{ max: 0 }]) // MAX(position) lookup
    fakeDb.data.queue.push([{ id: 't1', userId: 'user-1', position: 1 }]) // returning row
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    })
    expect(res.status).toBe(201)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'user_tabs')
  })

  it('PATCH /api/user-settings/tabs/:id calls notify with user_tabs', async () => {
    fakeDb.data.update = [{ id: 't1', userId: 'user-1' }]
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 5 }),
    })
    expect(res.status).toBe(200)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'user_tabs')
  })

  it('PATCH /api/user-settings/tabs/:id does NOT call notify on 404', async () => {
    fakeDb.data.update = []
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 5 }),
    })
    expect(res.status).toBe(404)
    expect(mockedNotify).not.toHaveBeenCalled()
  })

  it('DELETE /api/user-settings/tabs/:id calls notify with user_tabs', async () => {
    fakeDb.data.delete = [{ id: 't1' }]
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'user_tabs')
  })

  it('DELETE /api/user-settings/tabs/:id does NOT call notify on 404', async () => {
    fakeDb.data.delete = []
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/t1', { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(mockedNotify).not.toHaveBeenCalled()
  })

  it('POST /api/user-settings/tabs/reorder calls notify with user_tabs', async () => {
    // Inside the txn: select returns the owned ids, then per-id updates.
    fakeDb.data.queue.push([{ id: 'a' }, { id: 'b' }]) // ownership check
    // The update calls inside the txn don't await a result that's used.
    const app = makeApp(env)
    const res = await app.request('/api/user-settings/tabs/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ['a', 'b'] }),
    })
    expect(res.status).toBe(200)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'user_tabs')
  })

  it('PUT /api/preferences calls notify with user_preferences', async () => {
    fakeDb.data.insert = [{ userId: 'user-1' }]
    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'low' }),
    })
    expect(res.status).toBe(200)
    expect(mockedNotify).toHaveBeenCalledTimes(1)
    expect(mockedNotify).toHaveBeenCalledWith(env, 'user-1', 'user_preferences')
  })

  it('PUT /api/preferences does NOT call notify on validation 400', async () => {
    const app = makeApp(env)
    const res = await app.request('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'extreme' }),
    })
    expect(res.status).toBe(400)
    expect(mockedNotify).not.toHaveBeenCalled()
  })
})
