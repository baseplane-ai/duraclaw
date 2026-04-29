/**
 * GH#84: PATCH /api/projects/:name/customization — admin-only abbrev +
 * color-slot overrides for the tab strip. Mirrors the visibility-PATCH
 * test pattern: fakeDb satisfies the route's drizzle calls; we only
 * assert HTTP status, body shape, and which db verbs ran.
 */

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

vi.mock('~/lib/broadcast-synced-delta', () => ({
  broadcastSyncedDelta: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { createApiApp } from './index'

const mockedGetRequestSession = vi.mocked(getRequestSession)

function createMockEnv() {
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
  } as any
}

function makeApp(env: any) {
  const app = createApiApp()
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
  return {
    async request(path: string, init?: RequestInit) {
      const url = `http://localhost${path}`
      const req = new Request(url, init)
      return app.fetch(req, env, ctx)
    },
  }
}

function asAdmin() {
  mockedGetRequestSession.mockResolvedValue({
    userId: 'admin-1',
    role: 'admin',
    session: { id: 's' },
    user: { id: 'admin-1', role: 'admin' },
  })
}

function asUser() {
  mockedGetRequestSession.mockResolvedValue({
    userId: 'user-1',
    role: 'user',
    session: { id: 's' },
    user: { id: 'user-1', role: 'user' },
  })
}

const SAMPLE_ROW = {
  name: 'duraclaw',
  rootPath: '/data/projects/duraclaw',
  visibility: 'public',
  abbrev: null,
  colorSlot: null,
  displayName: null,
  updatedAt: '2026-04-29T00:00:00.000Z',
  deletedAt: null,
}

describe('PATCH /api/projects/:name/customization', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = createMockEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('admin can set abbrev to a valid 2-char value', async () => {
    asAdmin()
    // Sequence: UPDATE.returning() → SELECT post-update → SELECT user_presence rows.
    fakeDb.data.queue = [
      [{ name: 'duraclaw' }],
      [{ ...SAMPLE_ROW, abbrev: 'DZ' }],
      [{ userId: 'admin-1' }],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abbrev: 'DZ' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; abbrev: string | null }
    expect(body.ok).toBe(true)
    expect(body.abbrev).toBe('DZ')
    expect(fakeDb.db.update).toHaveBeenCalled()
  })

  it('admin can set color_slot to an in-range integer', async () => {
    asAdmin()
    fakeDb.data.queue = [
      [{ name: 'duraclaw' }],
      [{ ...SAMPLE_ROW, colorSlot: 4 }],
      [{ userId: 'admin-1' }],
    ]

    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color_slot: 4 }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; color_slot: number | null }
    expect(body.color_slot).toBe(4)
  })

  it('admin can clear both fields with explicit nulls', async () => {
    asAdmin()
    fakeDb.data.queue = [[{ name: 'duraclaw' }], [SAMPLE_ROW], [{ userId: 'admin-1' }]]

    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abbrev: null, color_slot: null }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      abbrev: string | null
      color_slot: number | null
    }
    expect(body.abbrev).toBeNull()
    expect(body.color_slot).toBeNull()
  })

  it.each([
    ['lowercase', 'dc'],
    ['mixed-case', 'Dc'],
    ['three-chars', 'ABC'],
    ['punctuation', 'A!'],
    ['empty', ''],
    ['whitespace', ' A'],
  ])('rejects invalid abbrev %s with 400', async (_label, abbrev) => {
    asAdmin()

    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abbrev }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_abbrev')
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  // Note: `NaN` doesn't survive `JSON.stringify` — it serializes as `null`,
  // which the handler treats as the explicit "clear" sentinel. So
  // wire-level invalid shapes are: out-of-range integers, floats, and
  // non-numbers. Including `NaN` here would actually exercise the
  // null-clear path, not the validator.
  it.each([
    ['negative', -1],
    ['out-of-range', 10],
    ['far-out-of-range', 999],
    ['float', 1.5],
    ['string', '5'],
  ])('rejects invalid color_slot %s with 400', async (_label, color_slot) => {
    asAdmin()

    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color_slot }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_color_slot')
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })

  it('rejects non-string abbrev', async () => {
    asAdmin()
    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abbrev: 42 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_abbrev')
  })

  it('returns 400 when no fields are supplied', async () => {
    asAdmin()
    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('no_fields_to_update')
  })

  it('returns 404 when the project name does not exist', async () => {
    asAdmin()
    // UPDATE.returning() yields empty (no row matched).
    fakeDb.data.queue = [[]]

    const app = makeApp(env)
    const res = await app.request('/api/projects/missing/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abbrev: 'XY' }),
    })

    expect(res.status).toBe(404)
  })

  it('returns 403 for non-admin caller', async () => {
    asUser()

    const app = makeApp(env)
    const res = await app.request('/api/projects/duraclaw/customization', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ abbrev: 'XY' }),
    })

    expect(res.status).toBe(403)
    expect(fakeDb.db.update).not.toHaveBeenCalled()
  })
})
