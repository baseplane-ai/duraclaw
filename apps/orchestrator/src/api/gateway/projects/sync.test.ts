import type { ProjectInfo } from '@duraclaw/shared-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { getRequestSession } from '../../auth-session'
import { installFakeDb, makeFakeDb } from '../../test-helpers'

vi.mock('../../auth-session', () => ({
  getRequestSession: vi.fn(),
}))

vi.mock('../../auth-routes', async () => {
  const { Hono } = await import('hono')
  return { authRoutes: new Hono() }
})

vi.mock('~/lib/broadcast-synced-delta', () => ({
  broadcastSyncedDelta: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { createApiApp } from '../../index'

const mockedBroadcast = vi.mocked(broadcastSyncedDelta)

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
    ASSETS: {},
    CC_GATEWAY_SECRET: 'gw-secret',
    SYNC_BROADCAST_SECRET: 'broadcast-secret',
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

function buildProject(name: string, path?: string): ProjectInfo {
  return {
    name,
    path: path ?? `/data/projects/${name}`,
    branch: 'main',
    dirty: false,
    active_session: null,
    repo_origin: null,
    ahead: 0,
    behind: 0,
    pr: null,
  }
}

/** Seed the FIFO queue so the sync handler's drizzle reads return:
 *  1) existing projects (SELECT ... FROM projects)
 *  2) per-incoming INSERT .onConflictDoUpdate — the fake resolves insert ops
 *     from `data.insert` (default []).
 *  3) existing presence rows (SELECT ... FROM user_presence)
 */
function seedForSync(
  fakeDb: ReturnType<typeof makeFakeDb>,
  opts: {
    existing: Array<{ name: string; deletedAt: string | null }>
    incoming: number
    presenceUsers: string[]
  },
) {
  // 1. SELECT projects (with name + deletedAt)
  fakeDb.data.queue.push(opts.existing)
  // 2. For each incoming row: one INSERT → return []
  for (let i = 0; i < opts.incoming; i++) fakeDb.data.queue.push([])
  // 3. If there are soft-deletions, an UPDATE → return []
  //    The handler only issues the UPDATE when toDelete.length > 0; we
  //    push a speculative [] that's only consumed in that case. If the
  //    test has no soft-deletes, the queue item below goes to the
  //    presence SELECT directly.
  const needsUpdate = opts.existing.some((e) => !e.deletedAt) // any live row that might be absent
  // Compute real need: rows present in `existing` but not in the test's
  // implicit incoming list is not known here; tests will push an extra
  // [] themselves if they expect a soft-delete UPDATE.
  void needsUpdate
  // 4. SELECT user_presence — map each user to {userId: …}
  fakeDb.data.queue.push(opts.presenceUsers.map((userId) => ({ userId })))
}

describe('POST /api/gateway/projects/sync', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedBroadcast.mockReset()
    mockedBroadcast.mockResolvedValue(undefined)
    vi.mocked(getRequestSession).mockResolvedValue(null)
  })

  it('returns 401 when no bearer provided', async () => {
    const { request } = makeApp(env)
    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 on wrong bearer', async () => {
    const { request } = makeApp(env)
    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer totally-wrong',
      },
      body: JSON.stringify({ projects: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 on malformed body', async () => {
    const { request } = makeApp(env)
    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw-secret',
      },
      body: JSON.stringify({ nope: 1 }),
    })
    expect(res.status).toBe(400)
  })

  it('happy path: upserts and broadcasts nothing when no presence rows exist', async () => {
    seedForSync(fakeDb, {
      existing: [],
      incoming: 3,
      presenceUsers: [],
    })

    const { request, collector } = makeApp(env)
    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw-secret',
      },
      body: JSON.stringify({
        projects: [buildProject('alpha'), buildProject('beta'), buildProject('gamma')],
      }),
    })

    expect(res.status).toBe(204)
    // waitUntil fires one background job for the fanout — but presence is
    // empty, so the job runs zero broadcasts.
    await Promise.all(collector.promises)
    expect(mockedBroadcast).not.toHaveBeenCalled()
    // Three INSERT ... ON CONFLICT calls expected (one per incoming row).
    expect(fakeDb.db.insert).toHaveBeenCalledTimes(3)
  })

  it('fans out to every active-presence user', async () => {
    seedForSync(fakeDb, {
      existing: [],
      incoming: 1,
      presenceUsers: ['user-A', 'user-B'],
    })

    const { request, collector } = makeApp(env)
    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw-secret',
      },
      body: JSON.stringify({ projects: [buildProject('alpha')] }),
    })

    expect(res.status).toBe(204)
    await Promise.all(collector.promises)

    expect(mockedBroadcast).toHaveBeenCalledTimes(2)
    const calledUsers = mockedBroadcast.mock.calls.map((c) => c[1])
    expect(new Set(calledUsers)).toEqual(new Set(['user-A', 'user-B']))
    // Collection name is 'projects' in every call.
    for (const call of mockedBroadcast.mock.calls) {
      expect(call[2]).toBe('projects')
    }
  })

  it('partial failure: one rejection does not abort the rest', async () => {
    seedForSync(fakeDb, {
      existing: [],
      incoming: 1,
      presenceUsers: ['user-A', 'user-B', 'user-C'],
    })

    mockedBroadcast.mockImplementation(async (_env, userId) => {
      if (userId === 'user-B') throw new Error('DO unreachable')
    })

    const { request, collector } = makeApp(env)
    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw-secret',
      },
      body: JSON.stringify({ projects: [buildProject('alpha')] }),
    })

    expect(res.status).toBe(204)
    await Promise.all(collector.promises)

    expect(mockedBroadcast).toHaveBeenCalledTimes(3)
    const calledUsers = mockedBroadcast.mock.calls.map((c) => c[1])
    expect(new Set(calledUsers)).toEqual(new Set(['user-A', 'user-B', 'user-C']))
  })

  it('reconcile soft-delete: rows absent from payload become deletes', async () => {
    // Seed: 3 existing live rows; incoming has only 2 of them.
    fakeDb.data.queue.push([
      { name: 'alpha', deletedAt: null },
      { name: 'beta', deletedAt: null },
      { name: 'gamma', deletedAt: null },
    ])
    // 2 INSERT upserts
    fakeDb.data.queue.push([])
    fakeDb.data.queue.push([])
    // 1 UPDATE (soft-delete of gamma)
    fakeDb.data.queue.push([])
    // Presence: one user → one broadcast call expected with delete op.
    fakeDb.data.queue.push([{ userId: 'user-A' }])

    const { request, collector } = makeApp(env)
    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw-secret',
      },
      body: JSON.stringify({
        projects: [buildProject('alpha'), buildProject('beta')],
      }),
    })

    expect(res.status).toBe(204)
    await Promise.all(collector.promises)

    expect(mockedBroadcast).toHaveBeenCalledTimes(1)
    const ops = mockedBroadcast.mock.calls[0][3] as Array<{ type: string; key?: string }>
    expect(ops.some((o) => o.type === 'delete' && o.key === 'gamma')).toBe(true)
    // alpha + beta arrive as update ops (existed + incoming) — both live, no inserts.
    expect(ops.filter((o) => o.type === 'update')).toHaveLength(2)
  })

  it('chunks a large payload into multiple broadcasts per user', async () => {
    // 500 rows with sizeable path strings → guaranteed to exceed 2 KiB cap.
    const manyProjects = Array.from({ length: 500 }, (_, i) =>
      buildProject(
        `proj-${String(i).padStart(5, '0')}`,
        `/data/projects/${'x'.repeat(80)}/proj-${i}`,
      ),
    )
    fakeDb.data.queue.push([]) // no existing
    for (let i = 0; i < manyProjects.length; i++) fakeDb.data.queue.push([])
    fakeDb.data.queue.push([{ userId: 'user-A' }])

    const { request, collector } = makeApp(
      createMockEnv({
        // Shrink the chunk cap via a spy-observable path: we can't easily
        // thread a custom maxBytes, but the default 200 KiB gets hit once
        // the ops array is big enough. 500 rows × ~250B per JSON op ≈ 125 KiB
        // — may or may not split. Force a split by appending a giant
        // display_name to each row.
      }),
    )

    // Overwrite env after makeApp — no, we already use the test env above.
    // Instead, bump the payload size so it reliably exceeds 200 KiB.
    const fatProjects = manyProjects.map((p) => ({
      ...p,
      // Cheap way to fatten JSON — the handler doesn't validate repo_origin.
      repo_origin: 'x'.repeat(500),
    }))

    // Reset fake queue for the real test run.
    fakeDb.data.queue = []
    fakeDb.data.queue.push([]) // no existing
    for (let i = 0; i < fatProjects.length; i++) fakeDb.data.queue.push([])
    fakeDb.data.queue.push([{ userId: 'user-A' }])

    const res = await request('/api/gateway/projects/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer gw-secret',
      },
      body: JSON.stringify({ projects: fatProjects }),
    })

    expect(res.status).toBe(204)
    await Promise.all(collector.promises)

    // User-A gets >1 broadcast because chunker splits into >1 frame.
    expect(mockedBroadcast.mock.calls.length).toBeGreaterThan(1)
    for (const call of mockedBroadcast.mock.calls) {
      expect(call[1]).toBe('user-A')
      expect(call[2]).toBe('projects')
    }
  })
})
