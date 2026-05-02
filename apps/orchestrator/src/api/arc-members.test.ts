// GH#152 P1 — REST tests for the per-arc membership routes mounted by
// `arcMembersRoutes()`. Covers the `owner-can-invite-and-remove` and
// `invitation-accept-flow` test cases from the spec, plus the
// last-owner / already-member / email_required guards and the email
// case-insensitivity rule.
//
// We mount `arcMembersRoutes()` directly into a fresh Hono<ApiAppEnv>
// app and stub `userId` + `role` via a tiny middleware — bypassing
// `authMiddleware` (which calls into Better Auth) keeps the test focused
// on the route handlers themselves. Same drizzle-d1 stub the rest of the
// `api/*.test.ts` suite uses.

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiAppEnv } from './context'
import { installFakeDb, makeFakeDb } from './test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { arcMembersRoutes } from './arc-members'

interface FakeAuth {
  userId: string | null
  role: string | null
}

function buildApp(auth: FakeAuth) {
  const app = new Hono<ApiAppEnv>()
  app.use('*', async (c, next) => {
    if (auth.userId) c.set('userId', auth.userId)
    if (auth.role) c.set('role', auth.role)
    await next()
  })
  app.route('/api/arcs', arcMembersRoutes())
  const env = { AUTH_DB: {} } as any
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
  return {
    request(path: string, init?: RequestInit) {
      const req = new Request(`http://localhost${path}`, init)
      return app.fetch(req, env, ctx)
    },
  }
}

const ARC = 'arc-1'
const OWNER = 'user-owner'
const MEMBER = 'user-member'
const TARGET = 'user-target'

describe('POST /api/arcs/:id/members — add or invite', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('owner adds an EXISTING user → 200 {kind:"added"} + arc_members insert', async () => {
    fakeDb.data.queue = [
      // checkArcAccess: arc lookup
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      // checkArcAccess: caller membership lookup
      [{ role: 'owner' }],
      // existing-user lookup (by email)
      [{ id: TARGET, email: 'target@example.com', name: 'Target' }],
      // dupe pre-check on arc_members
      [],
      // INSERT into arc_members
      [],
    ]

    const app = buildApp({ userId: OWNER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'target@example.com' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { kind: string; member: { userId: string } }
    expect(body.kind).toBe('added')
    expect(body.member.userId).toBe(TARGET)
    expect(fakeDb.db.insert).toHaveBeenCalled()
  })

  it('owner invites a NEW (non-existent) email → 200 {kind:"invited"} + arc_invitations insert', async () => {
    fakeDb.data.queue = [
      // checkArcAccess: arc lookup
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      // checkArcAccess: caller membership
      [{ role: 'owner' }],
      // existing-user lookup → empty
      [],
      // INSERT into arc_invitations
      [],
    ]

    const app = buildApp({ userId: OWNER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kind: string
      invitation: { token: string; email: string; expiresAt: string }
    }
    expect(body.kind).toBe('invited')
    expect(body.invitation.email).toBe('new@example.com')
    expect(typeof body.invitation.token).toBe('string')
    expect(body.invitation.token.length).toBeGreaterThan(8)
  })

  it('non-owner member → 403 not_owner', async () => {
    fakeDb.data.queue = [
      // checkArcAccess: arc lookup
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      // checkArcAccess: caller membership = member (allowed but not owner)
      [{ role: 'member' }],
    ]

    const app = buildApp({ userId: MEMBER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com' }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_owner')
  })

  it('missing body.email → 422 email_required', async () => {
    const app = buildApp({ userId: OWNER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('email_required')
  })

  it('adding an already-member existing user → 409 already_member', async () => {
    fakeDb.data.queue = [
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      [{ role: 'owner' }],
      [{ id: TARGET, email: 'target@example.com', name: 'Target' }],
      // dupe pre-check finds existing membership
      [{ userId: TARGET }],
    ]

    const app = buildApp({ userId: OWNER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'target@example.com' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('already_member')
  })

  it('unauthenticated request → 401', async () => {
    const app = buildApp({ userId: null, role: null })
    const res = await app.request(`/api/arcs/${ARC}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/arcs/:id/members/:userId — remove member', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('owner removes a non-owner member → 200 {removed:true}', async () => {
    fakeDb.data.queue = [
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      [{ role: 'owner' }],
      // target lookup
      [{ role: 'member' }],
      // delete
      [],
    ]
    const app = buildApp({ userId: OWNER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members/${TARGET}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { removed: boolean; userId: string }
    expect(body.removed).toBe(true)
    expect(body.userId).toBe(TARGET)
    expect(fakeDb.db.delete).toHaveBeenCalled()
  })

  it('non-owner attempting DELETE → 403 not_owner', async () => {
    fakeDb.data.queue = [
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      // caller is a plain member
      [{ role: 'member' }],
    ]
    const app = buildApp({ userId: MEMBER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members/${TARGET}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_owner')
  })

  it('sole owner self-removal → 409 last_owner', async () => {
    fakeDb.data.queue = [
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      [{ role: 'owner' }],
      // target (= caller) lookup → owner
      [{ role: 'owner' }],
      // count(*) of owners = 1
      [{ n: 1 }],
    ]
    const app = buildApp({ userId: OWNER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members/${OWNER}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('last_owner')
    expect(fakeDb.db.delete).not.toHaveBeenCalled()
  })

  it('removing an owner when 2+ owners exist → 200', async () => {
    fakeDb.data.queue = [
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      [{ role: 'owner' }],
      // target is also an owner
      [{ role: 'owner' }],
      // 2 owners total
      [{ n: 2 }],
      // delete
      [],
    ]
    const app = buildApp({ userId: OWNER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members/${TARGET}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    expect(fakeDb.db.delete).toHaveBeenCalled()
  })
})

describe('POST /api/arcs/invitations/:token/accept — invitation accept flow', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  function futureIso(): string {
    return new Date(Date.now() + 60 * 60 * 1000).toISOString()
  }
  function pastIso(): string {
    return new Date(Date.now() - 60 * 60 * 1000).toISOString()
  }

  it('valid token + matching email → 200 {arcId, role}', async () => {
    const invite = {
      token: 'tok-1',
      arcId: ARC,
      email: 'caller@example.com',
      role: 'member',
      invitedBy: OWNER,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: futureIso(),
      acceptedAt: null,
      acceptedBy: null,
    }
    fakeDb.data.queue = [
      [invite],
      // user email lookup
      [{ email: 'caller@example.com' }],
      // batch results — arc_members insert + arc_invitations update
      [],
      [],
    ]

    const app = buildApp({ userId: TARGET, role: 'user' })
    const res = await app.request(`/api/arcs/invitations/tok-1/accept`, {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { arcId: string; role: string }
    expect(body.arcId).toBe(ARC)
    expect(body.role).toBe('member')
  })

  it('case-insensitive email match accepts (uppercase invite vs lowercase user)', async () => {
    const invite = {
      token: 'tok-2',
      arcId: ARC,
      email: 'Caller@Example.COM',
      role: 'member',
      invitedBy: OWNER,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: futureIso(),
      acceptedAt: null,
      acceptedBy: null,
    }
    fakeDb.data.queue = [[invite], [{ email: 'caller@example.com' }], [], []]

    const app = buildApp({ userId: TARGET, role: 'user' })
    const res = await app.request(`/api/arcs/invitations/tok-2/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
  })

  it('expired token → 410 invitation_expired', async () => {
    const invite = {
      token: 'tok-3',
      arcId: ARC,
      email: 'caller@example.com',
      role: 'member',
      invitedBy: OWNER,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: pastIso(),
      acceptedAt: null,
      acceptedBy: null,
    }
    fakeDb.data.queue = [[invite]]

    const app = buildApp({ userId: TARGET, role: 'user' })
    const res = await app.request(`/api/arcs/invitations/tok-3/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invitation_expired')
  })

  it('wrong-email caller → 403 email_mismatch', async () => {
    const invite = {
      token: 'tok-4',
      arcId: ARC,
      email: 'someone@example.com',
      role: 'member',
      invitedBy: OWNER,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: futureIso(),
      acceptedAt: null,
      acceptedBy: null,
    }
    fakeDb.data.queue = [
      [invite],
      // caller's user-row email differs
      [{ email: 'imposter@example.com' }],
    ]

    const app = buildApp({ userId: TARGET, role: 'user' })
    const res = await app.request(`/api/arcs/invitations/tok-4/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('email_mismatch')
  })

  it('missing token → 404 invitation_not_found', async () => {
    fakeDb.data.queue = [[]]
    const app = buildApp({ userId: TARGET, role: 'user' })
    const res = await app.request(`/api/arcs/invitations/missing-tok/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invitation_not_found')
  })

  it('already-accepted invitation → 410 invitation_already_accepted', async () => {
    const invite = {
      token: 'tok-5',
      arcId: ARC,
      email: 'caller@example.com',
      role: 'member',
      invitedBy: OWNER,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: futureIso(),
      acceptedAt: '2026-04-01T00:00:00.000Z',
      acceptedBy: TARGET,
    }
    fakeDb.data.queue = [[invite]]
    const app = buildApp({ userId: TARGET, role: 'user' })
    const res = await app.request(`/api/arcs/invitations/tok-5/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invitation_already_accepted')
  })

  it('unauthenticated → 401', async () => {
    const app = buildApp({ userId: null, role: null })
    const res = await app.request(`/api/arcs/invitations/tok-x/accept`, {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/arcs/:id/members — list', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('member can list — returns members + invitations', async () => {
    fakeDb.data.queue = [
      // checkArcAccess: arc
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      // checkArcAccess: caller membership
      [{ role: 'member' }],
      // members rows
      [
        {
          userId: OWNER,
          email: 'o@example.com',
          name: 'Owner',
          role: 'owner',
          addedAt: '2026-04-01T00:00:00Z',
          addedBy: OWNER,
        },
      ],
      // invitations rows
      [
        {
          token: 'tok-a',
          email: 'pending@example.com',
          role: 'member',
          expiresAt: '2099-01-01T00:00:00Z',
          invitedBy: OWNER,
        },
      ],
    ]

    const app = buildApp({ userId: MEMBER, role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      members: Array<{ userId: string }>
      invitations: Array<{ token: string }>
    }
    expect(body.members).toHaveLength(1)
    expect(body.members[0]!.userId).toBe(OWNER)
    expect(body.invitations).toHaveLength(1)
    expect(body.invitations[0]!.token).toBe('tok-a')
  })

  it('non-member → 403 forbidden', async () => {
    fakeDb.data.queue = [
      [{ id: ARC, userId: OWNER, visibility: 'private' }],
      [], // not a member
    ]
    const app = buildApp({ userId: 'stranger', role: 'user' })
    const res = await app.request(`/api/arcs/${ARC}/members`)
    expect(res.status).toBe(403)
  })
})
