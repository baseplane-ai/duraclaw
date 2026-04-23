// Unit tests for spec #68 B3 — `getAccessibleSession` ACL gate.
//
// Covers the four cases the spec calls out in test id `p1-acl-unit`:
//   - owner sees their private session
//   - non-owner sees a public session (with isOwner=false)
//   - admin sees a private session they don't own
//   - non-owner non-admin on a private session gets 404 (not 403 — no
//     existence disclosure; matches getOwnedSession's shape)

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from './test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { getAccessibleSession } from './index'

function makeEnv() {
  return { AUTH_DB: {} } as any
}

describe('getAccessibleSession', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = makeEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('returns ok with isOwner=true for the session owner on a private session', async () => {
    fakeDb.data.select = [{ id: 's1', userId: 'user-A', visibility: 'private', project: 'p' }]
    const result = await getAccessibleSession(env, 's1', 'user-A', 'user')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.isOwner).toBe(true)
      expect(result.session.id).toBe('s1')
    }
  })

  it('returns ok with isOwner=false when a non-owner views a public session', async () => {
    fakeDb.data.select = [{ id: 's2', userId: 'user-A', visibility: 'public', project: 'p' }]
    const result = await getAccessibleSession(env, 's2', 'user-B', 'user')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.isOwner).toBe(false)
    }
  })

  it('grants admin access to a private session they do not own', async () => {
    fakeDb.data.select = [{ id: 's3', userId: 'user-A', visibility: 'private', project: 'p' }]
    const result = await getAccessibleSession(env, 's3', 'user-admin', 'admin')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.isOwner).toBe(false)
    }
  })

  it('returns 404 for non-owner non-admin on a private session (no existence disclosure)', async () => {
    fakeDb.data.select = [{ id: 's4', userId: 'user-A', visibility: 'private', project: 'p' }]
    const result = await getAccessibleSession(env, 's4', 'user-B', 'user')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }
  })

  it('returns 404 when the session does not exist', async () => {
    fakeDb.data.select = []
    const result = await getAccessibleSession(env, 'missing', 'user-A', 'user')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
    }
  })

  it('treats "system"-owned sessions as accessible to any authed user', async () => {
    fakeDb.data.select = [{ id: 's5', userId: 'system', visibility: 'private', project: 'p' }]
    const result = await getAccessibleSession(env, 's5', 'user-B', 'user')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.isOwner).toBe(true)
    }
  })
})
