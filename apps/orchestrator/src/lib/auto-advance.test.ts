import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from '../api/test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

vi.mock('~/lib/create-session', () => ({
  createSession: vi.fn(),
}))

vi.mock('~/lib/checkout-worktree', () => ({
  checkoutWorktree: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('~/lib/gateway-files', () => ({
  getSpecStatus: vi.fn().mockResolvedValue({ exists: true, status: 'approved' }),
  getVpStatus: vi.fn().mockResolvedValue({ exists: true }),
}))

import { checkoutWorktree } from '~/lib/checkout-worktree'
import { createSession } from '~/lib/create-session'
import { CORE_RUNGS, nextRung, tryAutoAdvance } from './auto-advance'

const mockedCreateSession = vi.mocked(createSession)
const mockedCheckoutWorktree = vi.mocked(checkoutWorktree)

function makeEnv() {
  return { AUTH_DB: {} } as any
}

function baseParams(overrides: Partial<Parameters<typeof tryAutoAdvance>[1]> = {}) {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    kataIssue: 42,
    kataMode: 'implementation',
    project: 'duraclaw',
    ...overrides,
  }
}

describe('nextRung', () => {
  it('maps research → planning → implementation → verify → close → null', () => {
    expect(nextRung('research')).toBe('planning')
    expect(nextRung('planning')).toBe('implementation')
    expect(nextRung('implementation')).toBe('verify')
    expect(nextRung('verify')).toBe('close')
    expect(nextRung('close')).toBeNull()
  })

  it('returns null for non-core rungs', () => {
    expect(nextRung('debug')).toBeNull()
    expect(nextRung('freeform')).toBeNull()
    expect(nextRung('task')).toBeNull()
    expect(nextRung('onboard')).toBeNull()
  })
})

describe('CORE_RUNGS', () => {
  it('contains exactly the 5 core rungs', () => {
    expect(CORE_RUNGS.has('research')).toBe(true)
    expect(CORE_RUNGS.has('planning')).toBe(true)
    expect(CORE_RUNGS.has('implementation')).toBe(true)
    expect(CORE_RUNGS.has('verify')).toBe(true)
    expect(CORE_RUNGS.has('close')).toBe(true)
    expect(CORE_RUNGS.has('debug')).toBe(false)
    expect(CORE_RUNGS.has('freeform')).toBe(false)
  })
})

describe('tryAutoAdvance', () => {
  let env: any
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    env = makeEnv()
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    mockedCreateSession.mockReset()
    mockedCheckoutWorktree.mockReset()
    mockedCheckoutWorktree.mockResolvedValue({ ok: true } as any)
  })

  it('returns {action:"none"} when the current mode is not a core rung', async () => {
    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'debug' }))
    expect(res).toEqual({ action: 'none' })
  })

  it('returns {action:"none"} when terminal core rung (close) has no successor', async () => {
    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'close' }))
    expect(res).toEqual({ action: 'none' })
  })

  it('returns {action:"none"} when user auto-advance preference is disabled (no row)', async () => {
    // readAutoAdvancePref → no row → false
    fakeDb.data.queue = [[] /* prefs row lookup */]
    const res = await tryAutoAdvance(env, baseParams())
    expect(res).toEqual({ action: 'none' })
    expect(mockedCreateSession).not.toHaveBeenCalled()
  })

  it('returns {action:"none"} when defaultChainAutoAdvance=false and no per-chain override', async () => {
    fakeDb.data.queue = [[{ chainsJson: null, defaultChainAutoAdvance: 0 }]]
    const res = await tryAutoAdvance(env, baseParams())
    expect(res).toEqual({ action: 'none' })
  })

  it('returns {action:"none"} (idempotent) when a non-terminal successor already exists', async () => {
    fakeDb.data.queue = [
      [{ chainsJson: null, defaultChainAutoAdvance: 1 }], // prefs: enabled
      [{ id: 'existing-verify-sess' }], // existing successor — idempotency guard
    ]
    const res = await tryAutoAdvance(env, baseParams())
    expect(res).toEqual({ action: 'none' })
    expect(mockedCreateSession).not.toHaveBeenCalled()
  })

  it('returns {action:"stalled"} when precondition fails (no completed prior rung)', async () => {
    fakeDb.data.queue = [
      [{ chainsJson: null, defaultChainAutoAdvance: 1 }], // prefs enabled
      [], // idempotency check — no existing successor
      // chainSessions lookup for precondition: impl session exists but numTurns=0
      [{ id: 's1', kataMode: 'implementation', status: 'idle', numTurns: 0 }],
    ]
    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'implementation' }))
    expect(res).toMatchObject({ action: 'stalled' })
    if (res.action === 'stalled') {
      expect(res.reason).toMatch(/No completed implementation session/)
    }
  })

  it('returns {action:"stalled"} when verify→close has no VP evidence', async () => {
    const { getVpStatus } = await import('~/lib/gateway-files')
    vi.mocked(getVpStatus).mockResolvedValueOnce({ exists: false } as any)

    fakeDb.data.queue = [
      [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
      [], // no existing successor
      [{ id: 's1', kataMode: 'verify', status: 'idle', numTurns: 3 }],
    ]
    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'verify' }))
    expect(res).toMatchObject({ action: 'stalled' })
    if (res.action === 'stalled') {
      expect(res.reason).toMatch(/VP evidence not found/)
    }
  })

  it('returns {action:"advanced"} on happy path (implementation → verify)', async () => {
    fakeDb.data.queue = [
      [{ chainsJson: null, defaultChainAutoAdvance: 1 }], // prefs enabled
      [], // no existing successor
      [
        // chain history — completed implementation session
        { id: 's-impl', kataMode: 'implementation', status: 'idle', numTurns: 5 },
      ],
    ]
    mockedCreateSession.mockResolvedValueOnce({ ok: true, sessionId: 'new-verify-sess' })

    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'implementation' }))

    expect(res).toEqual({
      action: 'advanced',
      newSessionId: 'new-verify-sess',
      nextMode: 'verify',
    })
    expect(mockedCreateSession).toHaveBeenCalledOnce()
    const call = mockedCreateSession.mock.calls[0]
    expect(call[1]).toBe('user-1')
    expect(call[2]).toMatchObject({
      project: 'duraclaw',
      prompt: 'enter verify',
      agent: 'verify',
      kataIssue: 42,
    })
  })

  it('honours per-chain override (autoAdvance:true) even if global default is false', async () => {
    fakeDb.data.queue = [
      [
        {
          chainsJson: JSON.stringify({ '42': { autoAdvance: true } }),
          defaultChainAutoAdvance: 0,
        },
      ],
      [],
      [{ id: 's-impl', kataMode: 'implementation', status: 'idle', numTurns: 1 }],
    ]
    mockedCreateSession.mockResolvedValueOnce({ ok: true, sessionId: 'new-sess' })

    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'implementation' }))
    expect(res).toMatchObject({ action: 'advanced', nextMode: 'verify' })
  })

  it('honours per-chain override (autoAdvance:false) even if global default is true', async () => {
    fakeDb.data.queue = [
      [
        {
          chainsJson: JSON.stringify({ '42': { autoAdvance: false } }),
          defaultChainAutoAdvance: 1,
        },
      ],
    ]
    const res = await tryAutoAdvance(env, baseParams())
    expect(res).toEqual({ action: 'none' })
    expect(mockedCreateSession).not.toHaveBeenCalled()
  })

  it('falls back to global default when chainsJson is malformed', async () => {
    fakeDb.data.queue = [[{ chainsJson: '{not json', defaultChainAutoAdvance: 0 }]]
    const res = await tryAutoAdvance(env, baseParams())
    expect(res).toEqual({ action: 'none' })
  })

  it('returns {action:"error"} when createSession throws', async () => {
    fakeDb.data.queue = [
      [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
      [],
      [{ id: 's-impl', kataMode: 'implementation', status: 'idle', numTurns: 1 }],
    ]
    mockedCreateSession.mockRejectedValueOnce(new Error('spawn blew up'))

    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'implementation' }))
    expect(res).toMatchObject({ action: 'error' })
    if (res.action === 'error') {
      expect(res.error).toMatch(/spawn blew up/)
    }
  })

  it('returns {action:"error"} when createSession returns {ok:false}', async () => {
    fakeDb.data.queue = [
      [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
      [],
      [{ id: 's-impl', kataMode: 'implementation', status: 'idle', numTurns: 1 }],
    ]
    mockedCreateSession.mockResolvedValueOnce({ ok: false, status: 500, error: 'boom' })

    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'implementation' }))
    expect(res).toEqual({ action: 'error', error: 'boom' })
  })

  it('returns {action:"stalled"} when worktree is held by another chain (409 conflict)', async () => {
    fakeDb.data.queue = [
      [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
      [],
      [{ id: 's-impl', kataMode: 'implementation', status: 'idle', numTurns: 1 }],
    ]
    mockedCheckoutWorktree.mockResolvedValueOnce({
      ok: false,
      status: 409,
      conflict: { issueNumber: 99 },
    } as any)

    const res = await tryAutoAdvance(env, baseParams({ kataMode: 'implementation' }))
    expect(res).toMatchObject({ action: 'stalled' })
    if (res.action === 'stalled') {
      expect(res.reason).toMatch(/Worktree held by chain #99/)
    }
  })

  describe('checkPreconditionServer parity (status==="idle" && numTurns>0)', () => {
    // The server-side precondition is verified by driving tryAutoAdvance
    // through the planning (research → planning) gate with various chain
    // histories. Client parity reference: isCompletedSession in
    // nav-sessions.tsx.

    it('treats numTurns===0 as "not completed" (draft)', async () => {
      fakeDb.data.queue = [
        [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
        [],
        [{ id: 's1', kataMode: 'research', status: 'idle', numTurns: 0 }],
      ]
      const res = await tryAutoAdvance(env, baseParams({ kataMode: 'research' }))
      expect(res).toMatchObject({ action: 'stalled' })
    })

    it('treats numTurns>0 && status==="idle" as completed', async () => {
      fakeDb.data.queue = [
        [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
        [],
        [{ id: 's1', kataMode: 'research', status: 'idle', numTurns: 2 }],
      ]
      mockedCreateSession.mockResolvedValueOnce({ ok: true, sessionId: 'new-plan' })
      const res = await tryAutoAdvance(env, baseParams({ kataMode: 'research' }))
      expect(res).toMatchObject({ action: 'advanced', nextMode: 'planning' })
    })

    it('rejects non-idle statuses even with numTurns>0', async () => {
      fakeDb.data.queue = [
        [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
        [],
        [{ id: 's1', kataMode: 'research', status: 'active', numTurns: 4 }],
      ]
      const res = await tryAutoAdvance(env, baseParams({ kataMode: 'research' }))
      expect(res).toMatchObject({ action: 'stalled' })
    })

    it('rejects null/undefined numTurns (defaults to 0)', async () => {
      fakeDb.data.queue = [
        [{ chainsJson: null, defaultChainAutoAdvance: 1 }],
        [],
        [{ id: 's1', kataMode: 'research', status: 'idle', numTurns: null }],
      ]
      const res = await tryAutoAdvance(env, baseParams({ kataMode: 'research' }))
      expect(res).toMatchObject({ action: 'stalled' })
    })
  })
})
