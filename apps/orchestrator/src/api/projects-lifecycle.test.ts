/**
 * GH#122 P1.4 — claim, transfer, and users-picker route tests.
 *
 * Coverage matches the spec phase-p3b test_cases plus a couple of
 * route-level smoke tests that catch wiring regressions (e.g. the
 * non-member-without-admin gate on transfer).
 *
 * Harness mirrors `project-metadata-api.test.ts`: vi.mock auth-session
 * + drizzle-d1, drive routes via `app.fetch`. The fakeDb's
 * `transaction(cb)` runs cb(db), so the claim/transfer txns share the
 * same FIFO queue as ordinary reads — push entries in the order the
 * handler issues them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
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
const mockedBroadcast = vi.mocked(broadcastSyncedDelta)

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

interface WaitUntilCollector {
  waitUntil: ReturnType<typeof vi.fn>
  passThroughOnException: ReturnType<typeof vi.fn>
  promises: Promise<unknown>[]
}

function makeApp(env: any) {
  const app = createApiApp()
  const collector: WaitUntilCollector = {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      collector.promises.push(p)
    }),
    passThroughOnException: vi.fn(),
    promises: [],
  }
  return {
    collector,
    async request(path: string, init?: RequestInit) {
      const url = `http://localhost${path}`
      const req = new Request(url, init)
      return app.fetch(req, env, collector as any)
    },
  }
}

const adminSession = {
  userId: 'user-admin',
  role: 'admin',
  session: { id: 's' },
  user: { id: 'user-admin', role: 'admin' },
}
const userSession = {
  userId: 'user-1',
  role: 'user',
  session: { id: 's' },
  user: { id: 'user-1', role: 'user' },
}

describe('POST /api/projects/:projectId/claim (B-LIFECYCLE-1)', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockReset()
    mockedBroadcast.mockReset()
    mockedBroadcast.mockResolvedValue(undefined)
  })

  it('admin on null-owner project → 200 + ownerId + claimedAt', async () => {
    mockedGetRequestSession.mockResolvedValue(adminSession as any)
    // 1. SELECT precheck on projectMetadata.ownerId → null (claimable).
    fakeDb.data.queue.push([{ ownerId: null }])
    // 2. db.batch([UPDATE … .returning(), INSERT project_members]).
    //    UPDATE returns the new ownerId/updatedAt row; INSERT returns [].
    fakeDb.data.queue.push([{ ownerId: 'user-admin', updatedAt: '2026-04-29T00:00:00.000Z' }])
    fakeDb.data.queue.push([])
    // 3. (fanout, runs in waitUntil) — projectInfoFromMeta SELECT JOIN
    fakeDb.data.queue.push([
      {
        name: 'duraclaw',
        rootPath: '/data/projects/duraclaw',
        visibility: 'public',
        ownerId: 'user-admin',
      },
    ])
    // 4. SELECT user_presence
    fakeDb.data.queue.push([])

    const { request, collector } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/claim`, { method: 'POST' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      ownerId: 'user-admin',
      claimedAt: '2026-04-29T00:00:00.000Z',
    })
    // Membership row was inserted.
    expect(fakeDb.db.insert).toHaveBeenCalled()
    // Drain waitUntil so the fanout runs to completion (may be empty).
    await Promise.all(collector.promises)
  })

  it('admin on already-owned project → 409 already_owned', async () => {
    mockedGetRequestSession.mockResolvedValue(adminSession as any)
    // SELECT precheck returns a row with non-null ownerId → 409 immediately.
    fakeDb.data.queue.push([{ ownerId: 'user-other' }])

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/claim`, { method: 'POST' })

    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('already_owned')
    // INSERT into project_members must NOT happen on the lost-race path.
    expect(fakeDb.db.insert).not.toHaveBeenCalled()
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('admin on nonexistent project → 404 unknown-project', async () => {
    mockedGetRequestSession.mockResolvedValue(adminSession as any)
    // SELECT precheck returns no rows → 404 immediately.
    fakeDb.data.queue.push([])

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/claim`, { method: 'POST' })

    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('not_found')
    expect(body.reason).toBe('unknown-project')
    expect(fakeDb.db.insert).not.toHaveBeenCalled()
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('non-admin → 403 admin-required', async () => {
    mockedGetRequestSession.mockResolvedValue(userSession as any)

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/claim`, { method: 'POST' })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('forbidden')
    expect(body.reason).toBe('admin-required')
  })

  it('admin + bad projectId shape → 400', async () => {
    mockedGetRequestSession.mockResolvedValue(adminSession as any)

    const { request } = makeApp(env)
    const res = await request('/api/projects/not-hex/claim', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('no session → 401 (global authMiddleware)', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/claim`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('fanout: broadcasts a `projects` update op once per userPresence user', async () => {
    mockedGetRequestSession.mockResolvedValue(adminSession as any)
    fakeDb.data.queue.push([{ ownerId: null }]) // SELECT precheck → claimable
    fakeDb.data.queue.push([{ ownerId: 'user-admin', updatedAt: '2026-04-29T00:00:00.000Z' }]) // UPDATE returning
    fakeDb.data.queue.push([]) // INSERT project_members
    fakeDb.data.queue.push([
      {
        name: 'duraclaw',
        rootPath: '/data/projects/duraclaw',
        visibility: 'public',
        ownerId: 'user-admin',
      },
    ])
    fakeDb.data.queue.push([{ userId: 'user-A' }, { userId: 'user-B' }])

    const { request, collector } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/claim`, { method: 'POST' })
    expect(res.status).toBe(200)
    await Promise.all(collector.promises)

    expect(mockedBroadcast).toHaveBeenCalledTimes(2)
    const calledUsers = mockedBroadcast.mock.calls.map((c) => c[1])
    expect(new Set(calledUsers)).toEqual(new Set(['user-A', 'user-B']))
    for (const call of mockedBroadcast.mock.calls) {
      expect(call[2]).toBe('projects')
      const ops = call[3] as Array<{ type: string; value: Record<string, unknown> }>
      expect(ops).toHaveLength(1)
      expect(ops[0].type).toBe('update')
      expect(ops[0].value.ownerId).toBe('user-admin')
      expect(ops[0].value.projectId).toBe(VALID_PID)
    }
  })
})

describe('POST /api/projects/:projectId/transfer (B-LIFECYCLE-2)', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockReset()
    mockedBroadcast.mockReset()
    mockedBroadcast.mockResolvedValue(undefined)
  })

  // The owner case has the membership-gate (requireProjectMember) consult
  // project_members BEFORE the transaction starts. Push: (1) membership
  // SELECT → owner row, (2) txn validate-user SELECT, (3) txn current-owner
  // SELECT, (4) txn UPDATE projectMetadata, (5) txn DELETE old owner row,
  // (6) txn INSERT new owner row, (7) fanout SELECT JOIN, (8) fanout
  // user_presence SELECT.
  function seedHappyOwnerTransfer(currentOwner: string, newOwner: string) {
    fakeDb.data.queue.push([{ role: 'owner' }]) // requireProjectMember lookup
    fakeDb.data.queue.push([{ id: newOwner }]) // SELECT users WHERE id = newOwner
    fakeDb.data.queue.push([{ ownerId: currentOwner }]) // current-owner read
    fakeDb.data.queue.push([]) // UPDATE projectMetadata
    fakeDb.data.queue.push([]) // DELETE projectMembers (old owner)
    fakeDb.data.queue.push([]) // INSERT projectMembers (new owner)
    fakeDb.data.queue.push([
      {
        name: 'duraclaw',
        rootPath: '/data/projects/duraclaw',
        visibility: 'public',
        ownerId: newOwner,
      },
    ])
    fakeDb.data.queue.push([]) // user_presence
  }

  it('owner with valid newOwnerUserId → 200 + ownerId migrated', async () => {
    mockedGetRequestSession.mockResolvedValue(userSession as any)
    seedHappyOwnerTransfer('user-1', 'user-2')

    const { request, collector } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOwnerUserId: 'user-2' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, ownerId: 'user-2' })
    expect(body.transferredAt).toEqual(expect.any(String))
    // DELETE + INSERT both fire on the membership table.
    expect(fakeDb.db.delete).toHaveBeenCalled()
    expect(fakeDb.db.insert).toHaveBeenCalled()
    await Promise.all(collector.promises)
  })

  it('newOwnerUserId nonexistent → 400 unknown-user', async () => {
    mockedGetRequestSession.mockResolvedValue(userSession as any)
    fakeDb.data.queue.push([{ role: 'owner' }]) // membership gate
    fakeDb.data.queue.push([]) // SELECT users → empty

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOwnerUserId: 'ghost-user' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('bad_request')
    expect(body.reason).toBe('unknown-user')
    // Mutating queries must not fire.
    expect(fakeDb.db.update).not.toHaveBeenCalled()
    expect(fakeDb.db.delete).not.toHaveBeenCalled()
  })

  it('newOwnerUserId === current owner → 409 already-owner', async () => {
    mockedGetRequestSession.mockResolvedValue(userSession as any)
    fakeDb.data.queue.push([{ role: 'owner' }]) // membership gate
    fakeDb.data.queue.push([{ id: 'user-1' }]) // SELECT users
    fakeDb.data.queue.push([{ ownerId: 'user-1' }]) // current-owner read

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOwnerUserId: 'user-1' }),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('no_op')
    expect(body.reason).toBe('already-owner')
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('non-member non-admin → 403 not-a-project-member', async () => {
    mockedGetRequestSession.mockResolvedValue(userSession as any)
    // Membership lookup returns no row.
    fakeDb.data.queue.push([])

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOwnerUserId: 'user-2' }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('forbidden')
    expect(body.reason).toBe('not-a-project-member')
  })

  it('admin (not the current owner) → 200 (admin override)', async () => {
    mockedGetRequestSession.mockResolvedValue(adminSession as any)
    // requireProjectMember admin-override skips its SELECT — go straight
    // into the txn queue.
    fakeDb.data.queue.push([{ id: 'user-2' }]) // SELECT users
    fakeDb.data.queue.push([{ ownerId: 'user-1' }]) // current-owner read
    fakeDb.data.queue.push([]) // UPDATE projectMetadata
    fakeDb.data.queue.push([]) // DELETE projectMembers
    fakeDb.data.queue.push([]) // INSERT projectMembers
    fakeDb.data.queue.push([
      {
        name: 'duraclaw',
        rootPath: '/data/projects/duraclaw',
        visibility: 'public',
        ownerId: 'user-2',
      },
    ])
    fakeDb.data.queue.push([])

    const { request, collector } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOwnerUserId: 'user-2' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, ownerId: 'user-2' })
    await Promise.all(collector.promises)
  })

  it('missing/empty newOwnerUserId → 400 bad_request', async () => {
    mockedGetRequestSession.mockResolvedValue(userSession as any)
    // Body is checked before any DB query — no queue entries needed.
    fakeDb.data.queue.push([{ role: 'owner' }]) // membership gate

    const { request } = makeApp(env)
    const res = await request(`/api/projects/${VALID_PID}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  it('bad projectId shape → 400', async () => {
    mockedGetRequestSession.mockResolvedValue(adminSession as any)

    const { request } = makeApp(env)
    const res = await request('/api/projects/not-hex/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOwnerUserId: 'user-2' }),
    })
    // Either projectMetadataAuth/requireProjectMember rejects with 400 first,
    // or the inline PROJECT_ID_RE.test() does — both are valid 400 paths.
    expect(res.status).toBe(400)
  })
})

describe('GET /api/users/picker (B-API-1)', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedGetRequestSession.mockReset()
  })

  it('authed → 200 with [{id, displayName, email}] sorted ASC', async () => {
    mockedGetRequestSession.mockResolvedValue(userSession as any)
    fakeDb.data.queue.push([
      { id: 'u1', displayName: 'Alice', email: 'a@x' },
      { id: 'u2', displayName: 'Bob', email: 'b@x' },
    ])

    const { request } = makeApp(env)
    const res = await request('/api/users/picker')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toEqual([
      { id: 'u1', displayName: 'Alice', email: 'a@x' },
      { id: 'u2', displayName: 'Bob', email: 'b@x' },
    ])

    // Verify the chain called `.orderBy(...)` and `.limit(200)` — proves the
    // 200-cap + ASC contract.
    const op = fakeDb.ops.find((o) => o.kind === 'select')
    expect(op).toBeDefined()
    const limitCall = op?.calls.find((c) => c.method === 'limit')
    expect(limitCall?.args[0]).toBe(200)
    expect(op?.calls.some((c) => c.method === 'orderBy')).toBe(true)
  })

  it('no session → 401', async () => {
    mockedGetRequestSession.mockResolvedValue(null)

    const { request } = makeApp(env)
    const res = await request('/api/users/picker')
    expect(res.status).toBe(401)
  })
})
