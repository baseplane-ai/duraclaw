import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#119 P2: unit coverage for the LRU identity-selection helper.
 *
 * The helper was extracted from `triggerGatewayDial` into
 * `selectAndStampIdentity` so the LRU / cooldown / fail-open /
 * zero-identities branches are testable without spinning up a DO.
 *
 * SQL correctness (status='available', cooldown_until expiry,
 * last_used_at ordering) is the migration's responsibility — these
 * tests assert the helper consumes whatever D1's first()/run() returns.
 */

vi.mock('./status', () => ({
  syncIdentityNameToD1: vi.fn().mockResolvedValue(undefined),
}))

import { selectAndStampIdentity } from './runner-link'
import { syncIdentityNameToD1 } from './status'
import type { SessionDOContext } from './types'

interface PreparedRecord {
  sql: string
  binds: unknown[]
  firstResult?: unknown
  runResult?: unknown
  firstThrows?: unknown
  runThrows?: unknown
}

interface FakeD1 {
  prepare: ReturnType<typeof vi.fn>
  calls: PreparedRecord[]
  /** FIFO results for prepare(...).first(). */
  firstQueue: unknown[]
  /** FIFO results for prepare(...).run(). */
  runQueue: unknown[]
  firstThrows: unknown[]
  runThrows: unknown[]
}

function makeFakeD1(): FakeD1 {
  const fake: FakeD1 = {
    prepare: vi.fn(),
    calls: [],
    firstQueue: [],
    runQueue: [],
    firstThrows: [],
    runThrows: [],
  }
  fake.prepare.mockImplementation((sql: string) => {
    const record: PreparedRecord = { sql, binds: [] }
    fake.calls.push(record)
    const stmt = {
      bind(...args: unknown[]) {
        record.binds = args
        return stmt
      },
      async first() {
        if (fake.firstThrows.length > 0) {
          const err = fake.firstThrows.shift()
          throw err
        }
        return fake.firstQueue.shift() ?? null
      },
      async run() {
        if (fake.runThrows.length > 0) {
          const err = fake.runThrows.shift()
          throw err
        }
        return fake.runQueue.shift() ?? { success: true }
      },
    }
    return stmt
  })
  return fake
}

function makeCtx(d1: FakeD1) {
  const logEvent = vi.fn()
  const ctx = {
    env: { AUTH_DB: d1 },
    logEvent,
    ctx: { id: { toString: () => 'do-id-x' } },
  } as unknown as SessionDOContext
  return { ctx, logEvent }
}

const baseCmd = {
  type: 'execute' as const,
  project: 'duraclaw',
  prompt: 'hi',
}

describe('selectAndStampIdentity', () => {
  beforeEach(() => {
    vi.mocked(syncIdentityNameToD1).mockClear()
  })

  it('stamps runner_home from the LRU row D1 returns', async () => {
    const d1 = makeFakeD1()
    d1.firstQueue.push({ id: 'id-1', name: 'work1', home_path: '/home/work1' })
    const { ctx } = makeCtx(d1)

    const next = await selectAndStampIdentity(ctx, { ...baseCmd })

    expect(next.runner_home).toBe('/home/work1')
    // Query asserts cooldown filter syntax — light sanity check that the
    // helper hit the right SQL, but the real coverage lives in the
    // migration / a future D1 integration test.
    expect(d1.calls[0].sql).toContain('cooldown_until < datetime')
    expect(d1.calls[0].sql).toContain("status = 'available'")
  })

  it('returns the row D1 hands back regardless of cooldown filtering', async () => {
    // Cooldown filtering happens in SQL — this test pretends D1 already
    // skipped the cooldown row and returned the only available identity.
    const d1 = makeFakeD1()
    d1.firstQueue.push({ id: 'id-2', name: 'work2', home_path: '/home/work2' })
    const { ctx } = makeCtx(d1)

    const next = await selectAndStampIdentity(ctx, { ...baseCmd })

    expect(next.runner_home).toBe('/home/work2')
  })

  it('uses an expired-cooldown row that D1 returns (lazy expiry)', async () => {
    // SQL `cooldown_until < datetime('now')` makes expired rows reappear.
    // The helper just consumes whatever D1 hands it — assert no extra
    // client-side filtering layered on top.
    const d1 = makeFakeD1()
    d1.firstQueue.push({ id: 'id-expired', name: 'expired', home_path: '/home/expired' })
    const { ctx } = makeCtx(d1)

    const next = await selectAndStampIdentity(ctx, { ...baseCmd })

    expect(next.runner_home).toBe('/home/expired')
  })

  it('returns cmd unchanged when D1 has zero identities', async () => {
    const d1 = makeFakeD1()
    // first() yields null
    const { ctx, logEvent } = makeCtx(d1)

    const cmd = { ...baseCmd }
    const next = await selectAndStampIdentity(ctx, cmd)

    expect(next).toBe(cmd) // same reference returned, no allocation
    expect((next as { runner_home?: string }).runner_home).toBeUndefined()
    expect(logEvent).toHaveBeenCalledWith(
      'info',
      'identity',
      expect.stringContaining('no identity available'),
    )
    // No UPDATE issued when nothing is selected.
    expect(d1.calls.length).toBe(1)
    // Mirror to D1 also skipped.
    expect(syncIdentityNameToD1).not.toHaveBeenCalled()
  })

  it('fails open and logs a warn when SELECT throws', async () => {
    const d1 = makeFakeD1()
    d1.firstThrows.push(new Error('D1 down'))
    const { ctx, logEvent } = makeCtx(d1)

    const cmd = { ...baseCmd }
    const next = await selectAndStampIdentity(ctx, cmd)

    expect(next).toBe(cmd)
    expect((next as { runner_home?: string }).runner_home).toBeUndefined()
    expect(logEvent).toHaveBeenCalledWith(
      'warn',
      'identity',
      expect.stringContaining('identity selection failed'),
      expect.objectContaining({ error: 'D1 down' }),
    )
  })

  it('issues UPDATE last_used_at after a successful selection', async () => {
    const d1 = makeFakeD1()
    d1.firstQueue.push({ id: 'id-1', name: 'work1', home_path: '/home/work1' })
    const { ctx } = makeCtx(d1)

    await selectAndStampIdentity(ctx, { ...baseCmd })

    // calls[0] is the SELECT, calls[1] is the UPDATE.
    expect(d1.calls.length).toBe(2)
    const update = d1.calls[1]
    expect(update.sql).toMatch(/UPDATE\s+runner_identities/i)
    expect(update.sql).toContain('last_used_at')
    expect(update.binds).toEqual(['id-1'])
  })

  it('logs a warn but does not fail the spawn when UPDATE last_used_at throws', async () => {
    const d1 = makeFakeD1()
    d1.firstQueue.push({ id: 'id-1', name: 'work1', home_path: '/home/work1' })
    d1.runThrows.push(new Error('UPDATE failed'))
    const { ctx, logEvent } = makeCtx(d1)

    const next = await selectAndStampIdentity(ctx, { ...baseCmd })

    // runner_home still stamped — the inner UPDATE failure is non-fatal.
    expect(next.runner_home).toBe('/home/work1')
    expect(logEvent).toHaveBeenCalledWith(
      'warn',
      'identity',
      'failed to update last_used_at',
      expect.objectContaining({ identityId: 'id-1', error: 'UPDATE failed' }),
    )
  })

  it('mirrors the selected identity name to D1 via syncIdentityNameToD1', async () => {
    const d1 = makeFakeD1()
    d1.firstQueue.push({ id: 'id-1', name: 'work1', home_path: '/home/work1' })
    const { ctx } = makeCtx(d1)

    await selectAndStampIdentity(ctx, { ...baseCmd })

    expect(syncIdentityNameToD1).toHaveBeenCalledTimes(1)
    expect(syncIdentityNameToD1).toHaveBeenCalledWith(ctx, 'work1', expect.any(String))
  })

  it('logs the selected identity name at info level', async () => {
    const d1 = makeFakeD1()
    d1.firstQueue.push({ id: 'id-1', name: 'work1', home_path: '/home/work1' })
    const { ctx, logEvent } = makeCtx(d1)

    await selectAndStampIdentity(ctx, { ...baseCmd })

    expect(logEvent).toHaveBeenCalledWith(
      'info',
      'identity',
      'selected work1',
      expect.objectContaining({ identityId: 'id-1', homePath: '/home/work1' }),
    )
  })
})
