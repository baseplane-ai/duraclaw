// GH#122 P1.3 B-AUTH-1 + B-AUTH-6 unit tests.
//
// Mounts a tiny Hono app that fronts requireProjectMember with a dummy
// projectMetadataAuth stub. The stub respects the bearer header (sets
// bearerAuth=true) or falls through to a synthetic cookie session
// (sets userId+role=`user` by default; tests can override via the
// `x-test-userid` / `x-test-role` request headers).
//
// Why a stub instead of the real projectMetadataAuth? — the real one
// imports better-auth's `getRequestSession` (heavyweight), and this
// suite is purely about the membership-lookup branch logic. Bearer
// bypass is exercised end-to-end via `bearerAuth=true`.

import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import type { ApiAppEnv } from '../context'
import { installFakeDb, makeFakeDb } from '../test-helpers'
import { requireProjectMember } from './require-project-member'

const PROJECT_ID = '0123456789abcdef'

const stubAuth = createMiddleware<ApiAppEnv>(async (c, next) => {
  const auth = c.req.header('authorization') ?? ''
  if (auth.startsWith('Bearer ')) {
    c.set('bearerAuth', true)
    await next()
    return
  }
  const userId = c.req.header('x-test-userid')
  const role = c.req.header('x-test-role') ?? 'user'
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('userId', userId)
  c.set('role', role)
  c.set('bearerAuth', false)
  await next()
})

function makeApp(minRole: 'owner' | 'editor' | 'viewer') {
  const app = new Hono<ApiAppEnv>()
  app.get('/test/:projectId', stubAuth, requireProjectMember(minRole), (c) => c.json({ ok: true }))
  app.patch('/test/:projectId', stubAuth, requireProjectMember(minRole), (c) =>
    c.json({ ok: true }),
  )
  return app
}

function fakeEnv() {
  return { AUTH_DB: {} } as any
}

describe('requireProjectMember (B-AUTH-1, B-AUTH-6)', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('cookie PATCH from non-member → 403 not-a-project-member', async () => {
    fakeDb.data.queue.push([]) // SELECT project_members → empty
    const app = makeApp('owner')
    const res = await app.fetch(
      new Request(`http://t/test/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'x-test-userid': 'user-A', 'x-test-role': 'user' },
      }),
      fakeEnv(),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('forbidden')
    expect(body.reason).toBe('not-a-project-member')
    expect(body.requiredRole).toBe('owner')
    expect(body.actualRole).toBeNull()
  })

  it('cookie PATCH from owner → 200', async () => {
    fakeDb.data.queue.push([{ role: 'owner' }])
    const app = makeApp('owner')
    const res = await app.fetch(
      new Request(`http://t/test/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'x-test-userid': 'user-A', 'x-test-role': 'user' },
      }),
      fakeEnv(),
    )
    expect(res.status).toBe(200)
  })

  it('cookie PATCH from admin → 200 (admin override skips DB lookup)', async () => {
    // No queue entry — middleware must short-circuit before SELECT.
    const app = makeApp('owner')
    const res = await app.fetch(
      new Request(`http://t/test/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'x-test-userid': 'user-admin', 'x-test-role': 'admin' },
      }),
      fakeEnv(),
    )
    expect(res.status).toBe(200)
    expect(fakeDb.db.select).not.toHaveBeenCalled()
  })

  it('cookie PATCH from viewer when minRole=owner → 403 insufficient-role', async () => {
    fakeDb.data.queue.push([{ role: 'viewer' }])
    const app = makeApp('owner')
    const res = await app.fetch(
      new Request(`http://t/test/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'x-test-userid': 'user-A', 'x-test-role': 'user' },
      }),
      fakeEnv(),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.reason).toBe('insufficient-role')
    expect(body.requiredRole).toBe('owner')
    expect(body.actualRole).toBe('viewer')
  })

  it('bearer PATCH → 200 (bypass, no project_members lookup)', async () => {
    // No queue entry — bypass must short-circuit before SELECT.
    const app = makeApp('owner')
    const res = await app.fetch(
      new Request(`http://t/test/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer secret-anything' },
      }),
      fakeEnv(),
    )
    expect(res.status).toBe(200)
    expect(fakeDb.db.select).not.toHaveBeenCalled()
  })

  it('cookie PATCH with no session → 401 (stubAuth path)', async () => {
    const app = makeApp('owner')
    const res = await app.fetch(new Request(`http://t/test/${PROJECT_ID}`, { method: 'PATCH' }))
    expect(res.status).toBe(401)
  })

  describe('GET docs-files-style matrix (minRole=viewer)', () => {
    const cases: Array<{ role: 'viewer' | 'editor' | 'owner'; expect: 200 }> = [
      { role: 'viewer', expect: 200 },
      { role: 'editor', expect: 200 },
      { role: 'owner', expect: 200 },
    ]

    for (const { role, expect: status } of cases) {
      it(`cookie GET as ${role} → ${status}`, async () => {
        fakeDb.data.queue.push([{ role }])
        const app = makeApp('viewer')
        const res = await app.fetch(
          new Request(`http://t/test/${PROJECT_ID}`, {
            headers: { 'x-test-userid': 'user-A', 'x-test-role': 'user' },
          }),
          fakeEnv(),
        )
        expect(res.status).toBe(status)
      })
    }

    it('cookie GET as non-member → 403', async () => {
      fakeDb.data.queue.push([])
      const app = makeApp('viewer')
      const res = await app.fetch(
        new Request(`http://t/test/${PROJECT_ID}`, {
          headers: { 'x-test-userid': 'user-A', 'x-test-role': 'user' },
        }),
        fakeEnv(),
      )
      expect(res.status).toBe(403)
    })

    it('bearer GET → 200 (bypass)', async () => {
      const app = makeApp('viewer')
      const res = await app.fetch(
        new Request(`http://t/test/${PROJECT_ID}`, {
          headers: { Authorization: 'Bearer x' },
        }),
        fakeEnv(),
      )
      expect(res.status).toBe(200)
      expect(fakeDb.db.select).not.toHaveBeenCalled()
    })
  })

  it('rejects malformed projectId param with 400', async () => {
    const app = makeApp('viewer')
    const res = await app.fetch(
      new Request('http://t/test/not-hex', {
        headers: { 'x-test-userid': 'user-A', 'x-test-role': 'user' },
      }),
      fakeEnv(),
    )
    expect(res.status).toBe(400)
  })
})
