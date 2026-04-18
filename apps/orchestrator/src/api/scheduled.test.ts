// Unit test for src/api/scheduled.ts cron handler. Per spec B-API-5:
// "mock fetch to reject, assert the scheduled handler resolves (does
// not throw) and logs a warning". Plus a happy-path test that verifies
// the gateway response is upserted via Drizzle and a malformed-JSON
// test that verifies the dedicated invalid-shape branch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeDb, makeFakeDb } from './test-helpers'

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => (globalThis as any).__fakeDb),
}))

import { scheduled } from './scheduled'

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_DB: {},
    CC_GATEWAY_URL: 'https://gateway.test',
    CC_GATEWAY_SECRET: 'gw-secret',
    SESSION_REGISTRY: {} as any,
    SESSION_AGENT: {} as any,
    USER_SETTINGS: {} as any,
    BETTER_AUTH_SECRET: 'test',
    ASSETS: {} as any,
    ...overrides,
  } as any
}

const dummyEvent = { type: 'scheduled', scheduledTime: 0, cron: '*/5 * * * *' } as any
const dummyCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

describe('scheduled cron handler', () => {
  const originalFetch = globalThis.fetch
  let warnSpy: ReturnType<typeof vi.spyOn>
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    warnSpy.mockRestore()
  })

  it('resolves cleanly and warns when CC_GATEWAY_URL is missing', async () => {
    const env = makeEnv({ CC_GATEWAY_URL: undefined })
    await expect(scheduled(dummyEvent, env, dummyCtx)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CC_GATEWAY_URL not configured'))
  })

  it('resolves cleanly and warns when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    const env = makeEnv()
    await expect(scheduled(dummyEvent, env, dummyCtx)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cron] gateway unreachable: connection refused'),
    )
  })

  it('resolves cleanly and warns when gateway returns non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }))
    const env = makeEnv()
    await expect(scheduled(dummyEvent, env, dummyCtx)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[cron] gateway unreachable: status=503'),
    )
  })

  it('resolves cleanly and warns when response is not valid JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>oops</html>', { status: 200 }))
    const env = makeEnv()
    await expect(scheduled(dummyEvent, env, dummyCtx)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[cron] invalid response shape'))
  })

  it('resolves cleanly and warns when response shape is missing sessions[]', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ wrong: true }), { status: 200 }))
    const env = makeEnv()
    await expect(scheduled(dummyEvent, env, dummyCtx)).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[cron] invalid response shape'))
  })

  it('skips the transaction when sessions[] is empty', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), { status: 200 }))
    const env = makeEnv()
    await scheduled(dummyEvent, env, dummyCtx)
    expect(fakeDb.db.transaction).not.toHaveBeenCalled()
  })

  it('runs an UPSERT inside a single transaction for each discovered row', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sessions: [
            { sdk_session_id: 'sdk-1', project: 'p1' },
            { sdk_session_id: 'sdk-2', project: 'p2' },
          ],
        }),
        { status: 200 },
      ),
    )
    const env = makeEnv()
    await scheduled(dummyEvent, env, dummyCtx)
    expect(fakeDb.db.transaction).toHaveBeenCalledTimes(1)
    expect(fakeDb.db.insert).toHaveBeenCalledTimes(2)
  })
})
