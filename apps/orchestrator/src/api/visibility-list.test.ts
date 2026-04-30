// Spec #68 P2 — session-list widening + admin toggle + inherit-at-create.
//
// Covers:
//   - p2-list-public   : filter=all surfaces public sessions owned by others;
//                        filter=mine excludes them.
//   - p2-admin-toggle  : non-admin PATCH → 403; admin PATCH → 200 + body.
//   - p2-inherit       : createSession reads project visibility and stamps
//                        it onto the inserted row.

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

const broadcastSyncedDeltaMock = vi.fn().mockResolvedValue(undefined)
vi.mock('~/lib/broadcast-synced-delta', () => ({
  broadcastSyncedDelta: (...args: unknown[]) => broadcastSyncedDeltaMock(...args),
}))

vi.mock('~/lib/broadcast-session', () => ({
  broadcastSessionRow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('~/lib/gateway-files', () => ({
  resolveProjectPath: vi.fn().mockResolvedValue('/tmp/project-path'),
  fetchGatewayProjects: vi.fn().mockResolvedValue([]),
  fetchGatewayFile: vi.fn(),
  listGatewayFiles: vi.fn(),
  parseFrontmatter: vi.fn(),
}))

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { createSession } from '~/lib/create-session'
import { createApiApp } from './index'

const mockedGetRequestSession = vi.mocked(getRequestSession)

function createMockEnv() {
  return {
    SESSION_AGENT: {
      newUniqueId: vi.fn().mockReturnValue({ toString: () => 'do-new' }),
      idFromString: vi.fn(),
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), {
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
  } as any
}

function makeApp(env: any) {
  const app = createApiApp()
  const pendingWaits: Array<Promise<unknown>> = []
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      pendingWaits.push(p)
    }),
    passThroughOnException: vi.fn(),
  } as any
  return {
    async request(path: string, init?: RequestInit) {
      const url = `http://localhost${path}`
      const req = new Request(url, init)
      return app.fetch(req, env, ctx)
    },
    async drainWaits() {
      await Promise.all(pendingWaits.splice(0))
    },
  }
}

describe('GET /api/sessions — visibility widening (p2-list-public)', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-B',
      role: 'user',
      session: { id: 's' },
      user: { id: 'user-B', role: 'user' },
    } as any)
  })

  it('filter=all surfaces public sessions owned by others and marks isOwner=false', async () => {
    // The fake DB ignores the WHERE clause — simulate what the visibility-widened
    // query would actually return: one owned + one public-foreign row.
    fakeDb.data.select = [
      { id: 's-own', userId: 'user-B', visibility: 'private', project: 'p' },
      { id: 's-shared', userId: 'user-A', visibility: 'public', project: 'p' },
    ]

    const app = makeApp(env)
    const res = await app.request('/api/sessions?filter=all')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{ id: string; userId: string; isOwner: boolean }>
    }
    expect(body.sessions).toHaveLength(2)
    const own = body.sessions.find((s) => s.id === 's-own')
    const shared = body.sessions.find((s) => s.id === 's-shared')
    expect(own?.isOwner).toBe(true)
    expect(shared?.isOwner).toBe(false)
  })

  it('filter=mine still returns rows annotated with isOwner (caller-scoped)', async () => {
    // With filter=mine the server emits a user_id=? WHERE — we just verify the
    // response annotates isOwner correctly for whatever the DB returns.
    fakeDb.data.select = [{ id: 's-own', userId: 'user-B', visibility: 'private', project: 'p' }]

    const app = makeApp(env)
    const res = await app.request('/api/sessions?filter=mine')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{ id: string; isOwner: boolean }>
    }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.isOwner).toBe(true)
  })
})

describe('PATCH /api/sessions/:id/visibility — admin-only (p2-admin-toggle)', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('returns 403 for a non-admin caller', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-B',
      role: 'user',
      session: { id: 's' },
      user: { id: 'user-B', role: 'user' },
    } as any)

    const app = makeApp(env)
    const res = await app.request('/api/sessions/sess-1/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Forbidden')
  })

  it('returns 400 for an invalid visibility value', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'admin-1',
      role: 'admin',
      session: { id: 's' },
      user: { id: 'admin-1', role: 'admin' },
    } as any)

    const app = makeApp(env)
    const res = await app.request('/api/sessions/sess-1/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'bogus' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_visibility')
  })

  it('returns 400 when the visibility field is missing', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'admin-1',
      role: 'admin',
      session: { id: 's' },
      user: { id: 'admin-1', role: 'admin' },
    } as any)

    const app = makeApp(env)
    const res = await app.request('/api/sessions/sess-1/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_visibility')
  })

  it('returns 404 when session does not exist', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'admin-1',
      role: 'admin',
      session: { id: 's' },
      user: { id: 'admin-1', role: 'admin' },
    } as any)
    fakeDb.data.select = [] // no row found

    const app = makeApp(env)
    const res = await app.request('/api/sessions/missing/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })

    expect(res.status).toBe(404)
  })

  it('returns 200 and updates the row for an admin caller', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'admin-1',
      role: 'admin',
      session: { id: 's' },
      user: { id: 'admin-1', role: 'admin' },
    } as any)
    fakeDb.data.select = [{ id: 'sess-1', userId: 'user-A', visibility: 'private', project: 'p' }]

    const app = makeApp(env)
    const res = await app.request('/api/sessions/sess-1/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; visibility: string }
    expect(body.ok).toBe(true)
    expect(body.visibility).toBe('public')
    expect(fakeDb.db.update).toHaveBeenCalled()
  })
})

describe('GET /api/sessions/shared — cross-user public feed', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-B',
      role: 'user',
      session: { id: 's' },
      user: { id: 'user-B', role: 'user' },
    } as any)
  })

  it('returns only public sessions (non-owner) annotated isOwner=false', async () => {
    fakeDb.data.select = [
      { id: 's-shared-1', userId: 'user-A', visibility: 'public', project: 'p' },
      { id: 's-shared-2', userId: 'user-C', visibility: 'public', project: 'p' },
    ]

    const app = makeApp(env)
    const res = await app.request('/api/sessions/shared')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{ id: string; userId: string; isOwner: boolean }>
    }
    expect(body.sessions).toHaveLength(2)
    for (const s of body.sessions) {
      expect(s.isOwner).toBe(false)
    }
  })
})

describe('PATCH /api/projects/:name/visibility — admin-only', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('returns 403 for a non-admin caller', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'user-B',
      role: 'user',
      session: { id: 's' },
      user: { id: 'user-B', role: 'user' },
    } as any)

    const app = makeApp(env)
    const res = await app.request('/api/projects/my-proj/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Forbidden')
  })

  it('returns 400 for an invalid visibility value', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'admin-1',
      role: 'admin',
      session: { id: 's' },
      user: { id: 'admin-1', role: 'admin' },
    } as any)

    const app = makeApp(env)
    const res = await app.request('/api/projects/my-proj/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'bogus' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_visibility')
  })

  it('returns 200 for an admin caller when the project exists', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'admin-1',
      role: 'admin',
      session: { id: 's' },
      user: { id: 'admin-1', role: 'admin' },
    } as any)
    // The UPDATE … RETURNING chain terminates against `data.update`.
    fakeDb.data.update = [{ name: 'my-proj' }]

    const app = makeApp(env)
    const res = await app.request('/api/projects/my-proj/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; visibility: string }
    expect(body.ok).toBe(true)
    expect(body.visibility).toBe('public')
    expect(fakeDb.db.update).toHaveBeenCalled()
  })

  it('broadcasts a synced-collection delta to every presence-tracked user on success', async () => {
    mockedGetRequestSession.mockResolvedValue({
      userId: 'admin-1',
      role: 'admin',
      session: { id: 's' },
      user: { id: 'admin-1', role: 'admin' },
    } as any)
    broadcastSyncedDeltaMock.mockClear()
    // queue drives each awaited chain in order:
    //   [0] UPDATE … RETURNING → [{name}] (truthy, proceed)
    //   [1] SELECT project row → [{…visibility:'private'}]
    //   [2] SELECT userPresence → [{userId}, {userId}]
    fakeDb.data.queue = [
      [{ name: 'my-proj' }],
      [
        {
          name: 'my-proj',
          displayName: null,
          rootPath: '/tmp/my-proj',
          updatedAt: 't',
          deletedAt: null,
          visibility: 'private',
        },
      ],
      [{ userId: 'user-A' }, { userId: 'user-B' }],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/projects/my-proj/visibility', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    })
    await app.drainWaits()

    expect(res.status).toBe(200)
    expect(broadcastSyncedDeltaMock).toHaveBeenCalledTimes(2)
    for (const call of broadcastSyncedDeltaMock.mock.calls) {
      expect(call[2]).toBe('projects')
      expect(Array.isArray(call[3])).toBe(true)
      expect(call[3][0]).toMatchObject({ type: 'update' })
      expect(call[3][0].value).toMatchObject({ name: 'my-proj', visibility: 'private' })
    }
  })
})

describe('createSession — inherits project visibility (p2-inherit)', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('stamps visibility=public on the new row when the project is public', async () => {
    // First select = project-visibility lookup; anything else the route does
    // reuses the same stub (we only care about the insert values).
    fakeDb.data.select = [{ visibility: 'public' }]

    const insertValues: unknown[] = []
    const originalInsert = fakeDb.db.insert
    fakeDb.db.insert = vi.fn((...args: unknown[]) => {
      const chain = originalInsert(...args)
      // Intercept `.values(...)` so we can assert the row shape.
      const wrapped = new Proxy(chain, {
        get(target, prop) {
          if (prop === 'values') {
            return (row: unknown) => {
              insertValues.push(row)
              return (target as any).values(row)
            }
          }
          return (target as any)[prop]
        },
      })
      return wrapped
    })

    const ctx = { waitUntil: vi.fn() }
    const result = await createSession(env, 'user-A', { project: 'my-proj', prompt: 'hello' }, ctx)

    expect(result.ok).toBe(true)
    // GH#116: createSession now auto-creates an implicit arc first, then
    // inserts the agent_sessions row. We assert on the session row only.
    expect(insertValues).toHaveLength(2)
    const sessionRow = insertValues.find(
      (r): r is { project?: string } => typeof (r as any)?.project === 'string',
    )
    expect(sessionRow).toBeDefined()
    expect((sessionRow as any).visibility).toBe('public')
    expect((sessionRow as any).project).toBe('my-proj')
  })

  it('defaults visibility=public when the project row is missing', async () => {
    fakeDb.data.select = [] // no project row

    const insertValues: unknown[] = []
    const originalInsert = fakeDb.db.insert
    fakeDb.db.insert = vi.fn((...args: unknown[]) => {
      const chain = originalInsert(...args)
      const wrapped = new Proxy(chain, {
        get(target, prop) {
          if (prop === 'values') {
            return (row: unknown) => {
              insertValues.push(row)
              return (target as any).values(row)
            }
          }
          return (target as any)[prop]
        },
      })
      return wrapped
    })

    const ctx = { waitUntil: vi.fn() }
    const result = await createSession(
      env,
      'user-A',
      { project: 'unknown-proj', prompt: 'hello' },
      ctx,
    )

    expect(result.ok).toBe(true)
    // GH#116: implicit arc insert + session insert. Assert the session row.
    expect(insertValues).toHaveLength(2)
    const sessionRow = insertValues.find(
      (r): r is { project?: string } => typeof (r as any)?.project === 'string',
    )
    expect(sessionRow).toBeDefined()
    expect((sessionRow as any).visibility).toBe('public')
  })

  it('honors explicit visibility=private on the project row', async () => {
    fakeDb.data.select = [{ visibility: 'private' }]

    const insertValues: unknown[] = []
    const originalInsert = fakeDb.db.insert
    fakeDb.db.insert = vi.fn((...args: unknown[]) => {
      const chain = originalInsert(...args)
      const wrapped = new Proxy(chain, {
        get(target, prop) {
          if (prop === 'values') {
            return (row: unknown) => {
              insertValues.push(row)
              return (target as any).values(row)
            }
          }
          return (target as any)[prop]
        },
      })
      return wrapped
    })

    const ctx = { waitUntil: vi.fn() }
    const result = await createSession(
      env,
      'user-A',
      { project: 'locked-proj', prompt: 'hello' },
      ctx,
    )

    expect(result.ok).toBe(true)
    // GH#116: implicit arc insert + session insert. Assert the session row.
    expect(insertValues).toHaveLength(2)
    const sessionRow = insertValues.find(
      (r): r is { project?: string } => typeof (r as any)?.project === 'string',
    )
    expect(sessionRow).toBeDefined()
    expect((sessionRow as any).visibility).toBe('private')
  })
})
