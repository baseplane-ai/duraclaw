// Unit test for src/api/scheduled.ts cron handler.
// Tests that the cron fetches GET /sessions from the gateway,
// handles errors gracefully, and updates existing D1 rows with
// fresh cost/status data from the thin gateway snapshot.

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
  let logSpy: ReturnType<typeof vi.spyOn>
  let fakeDb: ReturnType<typeof makeFakeDb>

  beforeEach(() => {
    fakeDb = makeFakeDb()
    installFakeDb(fakeDb.db)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    warnSpy.mockRestore()
    logSpy.mockRestore()
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
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, sessions: [] }), { status: 200 }))
    const env = makeEnv()
    await scheduled(dummyEvent, env, dummyCtx)
    expect(fakeDb.db.transaction).not.toHaveBeenCalled()
  })

  it('fetches GET /sessions (not /sessions/discover) from the gateway', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, sessions: [] }), { status: 200 }))
    const env = makeEnv()
    await scheduled(dummyEvent, env, dummyCtx)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://gateway.test/sessions',
      expect.objectContaining({ headers: { Authorization: 'Bearer gw-secret' } }),
    )
  })

  it('updates existing rows with cost/status from gateway snapshots', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          sessions: [
            {
              session_id: 'gw-1',
              state: 'running',
              sdk_session_id: 'sdk-1',
              last_activity_ts: 1700000000000,
              last_event_seq: 42,
              cost: { input_tokens: 100, output_tokens: 200, usd: 0.05 },
              model: 'claude-opus-4-6',
              turn_count: 3,
            },
            {
              session_id: 'gw-2',
              state: 'completed',
              sdk_session_id: 'sdk-2',
              last_activity_ts: null,
              last_event_seq: 10,
              cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
              model: null,
              turn_count: 0,
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const env = makeEnv()
    await scheduled(dummyEvent, env, dummyCtx)
    expect(fakeDb.db.transaction).toHaveBeenCalledTimes(1)
    // Update (not insert) is called for each session with sdk_session_id
    expect(fakeDb.db.update).toHaveBeenCalledTimes(2)
  })
})
