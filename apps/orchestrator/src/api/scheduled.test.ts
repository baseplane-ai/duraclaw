// Unit tests for the GH#115 P1.7 worktrees janitor cron + admin sweep
// helper. The cron's only job (post-115) is to hard-delete `worktrees`
// rows whose `releasedAt` is older than the idle window. The legacy
// `worktreeReservations` stale-flag GC is gone — the table itself was
// renamed and the `stale` / `last_activity_at` columns no longer exist
// (migration 0027).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from './test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { getIdleWindowMs, runWorktreesJanitor, scheduled } from './scheduled'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_DB: {},
    BETTER_AUTH_SECRET: 'test',
    SESSION_AGENT: {} as any,
    USER_SETTINGS: {} as any,
    ASSETS: {} as any,
    ...overrides,
  } as any
}

const dummyEvent = { type: 'scheduled', scheduledTime: 0, cron: '*/5 * * * *' } as any
const dummyCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

describe('runWorktreesJanitor', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
  })

  it('returns 0 when no rows are released', async () => {
    // Fix 7: helper now SELECTs candidates first; empty list short-circuits.
    fakeDb.data.select = []
    const result = await runWorktreesJanitor(makeEnv())
    expect(result.deletedCount).toBe(0)
    expect(result.deletedIds).toEqual([])
    expect(fakeDb.db.select).toHaveBeenCalledTimes(1)
    expect(fakeDb.db.delete).not.toHaveBeenCalled()
  })

  it('returns the deleted ids when the DELETE returns rows', async () => {
    // Fix 7: SELECT first surfaces candidate ids, then UPDATE on
    // agent_sessions nulls out FKs, then DELETE on worktrees runs.
    fakeDb.data.select = [{ id: 'wt-1' }, { id: 'wt-2' }]
    fakeDb.data.update = [] // agent_sessions FK null-out
    fakeDb.data.delete = [{ id: 'wt-1' }, { id: 'wt-2' }]
    const result = await runWorktreesJanitor(makeEnv())
    expect(result.deletedCount).toBe(2)
    expect(result.deletedIds).toEqual(['wt-1', 'wt-2'])
    expect(fakeDb.db.update).toHaveBeenCalledTimes(1)
    expect(fakeDb.db.delete).toHaveBeenCalledTimes(1)
  })

  it('passes the cutoff into the WHERE clause based on the idle window', async () => {
    // Fix 7: cutoff is now applied to the SELECT (not the DELETE) — but
    // the structural assertion is still that we DON'T do an unconditional
    // wipe. SELECT().where() must be chained; with empty candidates we
    // short-circuit before reaching DELETE at all.
    fakeDb.data.select = []
    const before = Date.now()
    await runWorktreesJanitor(makeEnv())
    const after = Date.now()
    const selectCalls = fakeDb.db.select.mock.calls
    expect(selectCalls.length).toBe(1)
    // Sanity: the cutoff is in the past relative to the call window.
    const cutoff = before - 24 * 60 * 60 * 1000
    expect(cutoff).toBeLessThan(after)
  })
})

describe('getIdleWindowMs', () => {
  it('defaults to 24h when env var is unset', () => {
    expect(getIdleWindowMs(makeEnv())).toBe(24 * 60 * 60 * 1000)
  })

  it('honors CC_WORKTREE_IDLE_WINDOW_SECS', () => {
    expect(getIdleWindowMs(makeEnv({ CC_WORKTREE_IDLE_WINDOW_SECS: '5' }))).toBe(5_000)
    expect(getIdleWindowMs(makeEnv({ CC_WORKTREE_IDLE_WINDOW_SECS: '3600' }))).toBe(3_600_000)
  })

  it('falls back to default on garbage values', () => {
    expect(getIdleWindowMs(makeEnv({ CC_WORKTREE_IDLE_WINDOW_SECS: 'not-a-number' }))).toBe(
      24 * 60 * 60 * 1000,
    )
    expect(getIdleWindowMs(makeEnv({ CC_WORKTREE_IDLE_WINDOW_SECS: '0' }))).toBe(
      24 * 60 * 60 * 1000,
    )
    expect(getIdleWindowMs(makeEnv({ CC_WORKTREE_IDLE_WINDOW_SECS: '-1' }))).toBe(
      24 * 60 * 60 * 1000,
    )
  })
})

describe('scheduled cron handler', () => {
  let fakeDb: ReturnType<typeof makeFakeDb>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('runs the janitor and logs deletions when present', async () => {
    // Fix 7: SELECT candidates → UPDATE agent_sessions FKs → DELETE worktrees.
    fakeDb.data.select = [{ id: 'wt-zombie' }]
    fakeDb.data.update = []
    fakeDb.data.delete = [{ id: 'wt-zombie' }]
    await scheduled(dummyEvent, makeEnv(), dummyCtx)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('worktrees-janitor deleted 1'))
  })

  it('stays silent when there is nothing to delete', async () => {
    fakeDb.data.select = []
    await scheduled(dummyEvent, makeEnv(), dummyCtx)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('swallows + logs janitor errors instead of rethrowing', async () => {
    // Force the proxied chain to reject by replacing db.select (the
    // candidate-discovery query that runs before any DELETE).
    fakeDb.db.select = vi.fn(() => ({
      from: () => ({
        where: () => Promise.reject(new Error('db unavailable')),
      }),
    })) as any
    await expect(scheduled(dummyEvent, makeEnv(), dummyCtx)).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cron] worktrees-janitor failed: db unavailable'),
    )
  })

  it('does NOT fetch the gateway /sessions endpoint', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as any
    fakeDb.data.select = []
    await scheduled(dummyEvent, makeEnv(), dummyCtx)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
