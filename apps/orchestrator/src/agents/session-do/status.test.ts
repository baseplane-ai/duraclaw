import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#119 P2: unit coverage for `syncIdentityNameToD1` — the helper
 * that mirrors the runner identity name onto the D1 `agent_sessions`
 * row and broadcasts the row update so the UI sees the active
 * identity.
 */

vi.mock('~/lib/broadcast-session', () => ({
  broadcastSessionRow: vi.fn().mockResolvedValue(undefined),
}))

import { broadcastSessionRow } from '~/lib/broadcast-session'
import { syncIdentityNameToD1 } from './status'
import type { SessionDOContext } from './types'

interface FakeUpdate {
  set: ReturnType<typeof vi.fn>
  where: ReturnType<typeof vi.fn>
  setArg?: unknown
  whereArg?: unknown
  thenable: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}

function makeFakeD1Update(throwOnUpdate = false): {
  d1: { update: ReturnType<typeof vi.fn> }
  calls: FakeUpdate[]
} {
  const calls: FakeUpdate[] = []
  const update = vi.fn(() => {
    let resolveFn!: () => void
    let rejectFn!: (err: unknown) => void
    const thenable = new Promise<void>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
    const builder: FakeUpdate = {
      set: vi.fn(),
      where: vi.fn(),
      thenable,
      resolve: resolveFn,
      reject: rejectFn,
    }
    builder.set.mockImplementation((arg: unknown) => {
      builder.setArg = arg
      return builder
    })
    builder.where.mockImplementation((arg: unknown) => {
      builder.whereArg = arg
      // Awaiting `update().set().where()` triggers the SQL — settle here.
      if (throwOnUpdate) builder.reject(new Error('D1 down'))
      else builder.resolve()
      return builder.thenable
    })
    calls.push(builder)
    return builder
  })
  return { d1: { update }, calls }
}

function makeCtx(d1: { update: ReturnType<typeof vi.fn> }) {
  const logEvent = vi.fn()
  const ctx = {
    env: { AUTH_DB: {} },
    do: { d1, name: 'sess-1', messageSeq: 42 },
    ctx: {
      id: { toString: () => 'do-id-x' },
      waitUntil: (_p: Promise<unknown>) => {},
    },
    logEvent,
  } as unknown as SessionDOContext
  return { ctx, logEvent }
}

describe('syncIdentityNameToD1', () => {
  beforeEach(() => {
    vi.mocked(broadcastSessionRow).mockClear()
  })

  it('updates agent_sessions.identity_name and broadcasts the row', async () => {
    const { d1, calls } = makeFakeD1Update()
    const { ctx } = makeCtx(d1)

    await syncIdentityNameToD1(ctx, 'work1', '2026-04-26T00:00:00.000Z')

    expect(calls.length).toBe(1)
    expect(calls[0].setArg).toEqual({
      identityName: 'work1',
      messageSeq: 42,
      updatedAt: '2026-04-26T00:00:00.000Z',
    })
    // `where(eq(agentSessions.id, sessionId))` — we just assert it was called.
    expect(calls[0].where).toHaveBeenCalledTimes(1)

    expect(broadcastSessionRow).toHaveBeenCalledTimes(1)
    expect(broadcastSessionRow).toHaveBeenCalledWith(ctx.env, ctx.ctx, 'sess-1', 'update')
  })

  it('clears identity_name when passed null', async () => {
    const { d1, calls } = makeFakeD1Update()
    const { ctx } = makeCtx(d1)

    await syncIdentityNameToD1(ctx, null, '2026-04-26T00:00:00.000Z')

    expect(calls[0].setArg).toMatchObject({ identityName: null })
  })

  it('swallows D1 errors and logs a warn', async () => {
    const { d1 } = makeFakeD1Update(true)
    const { ctx, logEvent } = makeCtx(d1)

    // Must not throw.
    await expect(
      syncIdentityNameToD1(ctx, 'work1', '2026-04-26T00:00:00.000Z'),
    ).resolves.toBeUndefined()

    expect(logEvent).toHaveBeenCalledWith(
      'warn',
      'identity',
      'failed to sync identity_name to D1',
      expect.objectContaining({ error: 'D1 down' }),
    )
    // Broadcast skipped on D1 failure.
    expect(broadcastSessionRow).not.toHaveBeenCalled()
  })
})
