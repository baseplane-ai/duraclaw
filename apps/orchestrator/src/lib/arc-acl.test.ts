// GH#152 P1 — unit tests for `checkArcAccess` (per-arc ACL gate).
//
// Covers the spec's `check-arc-access-public` and
// `check-arc-access-private-blocks` test cases plus the admin override,
// the `userId === 'system'` actor escape hatch, and the missing-arc
// branch.
//
// Reuses the same drizzle-d1 stub the `api/visibility.test.ts` and
// `api/admin-codex-models.test.ts` tests use — we don't need a real
// SQLite, just a fluent chain that resolves the queued select results
// in the order `checkArcAccess` issues them. That keeps the test focused
// on the predicate logic rather than SQL fidelity.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from '~/api/test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { drizzle } from 'drizzle-orm/d1'
import { checkArcAccess } from './arc-acl'
import type { Env } from './types'

function makeEnv(): Env {
  return { AUTH_DB: {} } as unknown as Env
}

describe('checkArcAccess', () => {
  let env: Env
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = makeEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  // The drizzle() factory is mocked to return the fake; cast so tests
  // can pass it through `checkArcAccess` without leaking `any` to the
  // surrounding call sites.
  const db = () => drizzle({} as any) as any

  it('public arc: any authed non-member returns allowed=true, role=null', async () => {
    fakeDb.data.queue = [
      // arc lookup
      [{ id: 'arc-1', userId: 'owner-A', visibility: 'public' }],
      // member lookup → no row
      [],
    ]

    const result = await checkArcAccess(env, db(), 'arc-1', {
      userId: 'user-B',
      role: 'user',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBeNull()
    expect(result.reason).toBeUndefined()
  })

  it('public arc: an authed user that IS a member returns their stored role', async () => {
    fakeDb.data.queue = [
      [{ id: 'arc-1', userId: 'owner-A', visibility: 'public' }],
      [{ role: 'member' }],
    ]

    const result = await checkArcAccess(env, db(), 'arc-1', {
      userId: 'user-B',
      role: 'user',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBe('member')
  })

  it('public arc: an owner-membership user returns role=owner', async () => {
    fakeDb.data.queue = [
      [{ id: 'arc-1', userId: 'owner-A', visibility: 'public' }],
      [{ role: 'owner' }],
    ]

    const result = await checkArcAccess(env, db(), 'arc-1', {
      userId: 'owner-A',
      role: 'user',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBe('owner')
  })

  it('private arc: non-member non-admin → allowed=false, reason=forbidden', async () => {
    fakeDb.data.queue = [
      [{ id: 'arc-2', userId: 'owner-A', visibility: 'private' }],
      [], // not in arc_members
    ]

    const result = await checkArcAccess(env, db(), 'arc-2', {
      userId: 'user-B',
      role: 'user',
    })

    expect(result.allowed).toBe(false)
    expect(result.role).toBeNull()
    expect(result.reason).toBe('forbidden')
  })

  it('private arc: a member sees their role', async () => {
    fakeDb.data.queue = [
      [{ id: 'arc-2', userId: 'owner-A', visibility: 'private' }],
      [{ role: 'member' }],
    ]

    const result = await checkArcAccess(env, db(), 'arc-2', {
      userId: 'user-B',
      role: 'user',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBe('member')
  })

  it('admin override: admin gets allowed=true with role=owner regardless of membership', async () => {
    fakeDb.data.queue = [
      // arc lookup — arc itself is private and admin is not in members
      [{ id: 'arc-3', userId: 'owner-A', visibility: 'private' }],
    ]

    const result = await checkArcAccess(env, db(), 'arc-3', {
      userId: 'admin-1',
      role: 'admin',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBe('owner')
  })

  it('admin override: works on a public arc too (no extra DB roundtrips)', async () => {
    fakeDb.data.queue = [[{ id: 'arc-4', userId: 'owner-A', visibility: 'public' }]]

    const result = await checkArcAccess(env, db(), 'arc-4', {
      userId: 'admin-1',
      role: 'admin',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBe('owner')
  })

  it("system-actor: arc with userId='system' allows any authed user (member role passes through)", async () => {
    fakeDb.data.queue = [
      [{ id: 'arc-sys', userId: 'system', visibility: 'private' }],
      [], // not a member
    ]

    const result = await checkArcAccess(env, db(), 'arc-sys', {
      userId: 'user-X',
      role: 'user',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBeNull()
  })

  it("system-actor: surfaces the user's actual role when they ARE a member", async () => {
    fakeDb.data.queue = [
      [{ id: 'arc-sys', userId: 'system', visibility: 'private' }],
      [{ role: 'owner' }],
    ]

    const result = await checkArcAccess(env, db(), 'arc-sys', {
      userId: 'user-X',
      role: 'user',
    })

    expect(result.allowed).toBe(true)
    expect(result.role).toBe('owner')
  })

  it('missing arc: returns allowed=false, reason=arc_not_found', async () => {
    fakeDb.data.queue = [[]] // arc lookup → no row

    const result = await checkArcAccess(env, db(), 'arc-missing', {
      userId: 'user-A',
      role: 'user',
    })

    expect(result.allowed).toBe(false)
    expect(result.role).toBeNull()
    expect(result.reason).toBe('arc_not_found')
  })

  it('null userSession: returns allowed=false, reason=unauthenticated', async () => {
    const result = await checkArcAccess(env, db(), 'arc-1', null)
    expect(result.allowed).toBe(false)
    expect(result.role).toBeNull()
    expect(result.reason).toBe('unauthenticated')
  })
})
