// Unit test for src/api/scheduled.ts cron handler.
//
// The cron's only job is the worktree-reservation stale GC. The prior
// gateway-session reconciliation was deleted because it duplicated the
// DO's D1 sync writes and bulk-bumped `last_activity` on every
// tick (see commit history).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scheduled } from './scheduled'

function makeRunSpy() {
  return vi.fn().mockResolvedValue({ success: true, meta: {} })
}

function makeEnv(runSpy = makeRunSpy()) {
  return {
    AUTH_DB: {
      prepare: vi.fn(() => ({ run: runSpy })),
    },
    CC_GATEWAY_URL: 'https://gateway.test',
    CC_GATEWAY_SECRET: 'gw-secret',
    SESSION_AGENT: {} as any,
    USER_SETTINGS: {} as any,
    BETTER_AUTH_SECRET: 'test',
    ASSETS: {} as any,
  } as any
}

const dummyEvent = { type: 'scheduled', scheduledTime: 0, cron: '*/5 * * * *' } as any
const dummyCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

describe('scheduled cron handler', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('runs the worktree stale-flag GC — two UPDATEs (mark + clear)', async () => {
    const runSpy = makeRunSpy()
    const env = makeEnv(runSpy)
    await scheduled(dummyEvent, env, dummyCtx)
    expect(env.AUTH_DB.prepare).toHaveBeenCalledTimes(2)
    expect(runSpy).toHaveBeenCalledTimes(2)
  })

  it('resolves cleanly when the GC throws — error is logged, not rethrown', async () => {
    const env = makeEnv()
    env.AUTH_DB.prepare = vi.fn(() => ({
      run: vi.fn().mockRejectedValue(new Error('db unavailable')),
    }))
    await expect(scheduled(dummyEvent, env, dummyCtx)).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cron] worktree-stale-gc failed: db unavailable'),
    )
  })

  it('does NOT fetch the gateway /sessions endpoint', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as any
    await scheduled(dummyEvent, makeEnv(), dummyCtx)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
