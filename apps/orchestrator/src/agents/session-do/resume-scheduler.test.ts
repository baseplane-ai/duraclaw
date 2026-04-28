import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#119 P3: unit coverage for the auto-failover state machine in
 * `resume-scheduler.ts`.
 *
 * Surface under test:
 *   - `handleRateLimit(ctx, event, reason?)` — entry from
 *     `gateway-event-handler.ts` (rate_limit / result-error routing) and
 *     the debug-simulate route. Cools down the current identity, picks a
 *     successor via `findAvailableIdentity`, broadcasts a `FailoverEvent`,
 *     fires `triggerGatewayDial({type:'resume', session_store_enabled:true})`.
 *     Falls back to `waiting_identity` + alarm-loop when no identity is
 *     available.
 *   - `checkWaitingIdentity(ctx)` — alarm-loop body. Bails when status is
 *     not `waiting_identity`. On hit: failover. On miss: bumps retries +
 *     re-arms. After 30 misses: declares the session failed.
 *
 * `triggerGatewayDial` and `findAvailableIdentity` live in `runner-link.ts`
 * — we mock the module so the dial is a spy and the LRU lookup is a stub.
 * `updateState` / `persistMetaPatch` live in `status.ts` — also mocked so
 * we capture patches without dragging in `broadcastSessionRow` /
 * Drizzle / D1 row updates.
 */

vi.mock('./runner-link', () => ({
  findAvailableIdentity: vi.fn(),
  triggerGatewayDial: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./status', () => ({
  updateState: vi.fn(),
  persistMetaPatch: vi.fn(),
}))

import type { GatewayEvent } from '~/lib/types'
import { checkWaitingIdentity, handleRateLimit } from './resume-scheduler'
import { findAvailableIdentity, triggerGatewayDial } from './runner-link'
import { persistMetaPatch, updateState } from './status'
import type { SessionDOContext } from './types'

interface PreparedRecord {
  sql: string
  binds: unknown[]
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
        if (fake.firstThrows.length > 0) throw fake.firstThrows.shift()
        return fake.firstQueue.shift() ?? null
      },
      async run() {
        if (fake.runThrows.length > 0) throw fake.runThrows.shift()
        return fake.runQueue.shift() ?? { success: true }
      },
    }
    return stmt
  })
  return fake
}

interface CtxOpts {
  status?: string
  runner_session_id?: string | null
  project?: string | null
  session_id?: string | null
  waiting_identity_retries?: number
}

function makeCtx(d1: FakeD1, opts: CtxOpts = {}) {
  const logEvent = vi.fn()
  const broadcast = vi.fn()
  const setState = vi.fn()
  const setAlarm = vi.fn()
  const state = {
    status: opts.status ?? 'running',
    runner_session_id: opts.runner_session_id ?? 'sdk-abc',
    project: opts.project ?? '/p',
    session_id: opts.session_id ?? 'sess-1',
    waiting_identity_retries: opts.waiting_identity_retries ?? 0,
  }
  const ctx = {
    env: { AUTH_DB: d1 },
    state,
    do: {
      name: 'sess-1',
      setState,
    },
    ctx: {
      id: { toString: () => 'do-id-x' },
      storage: { setAlarm },
    },
    logEvent,
    broadcast,
  } as unknown as SessionDOContext
  return { ctx, logEvent, broadcast, setState, setAlarm }
}

function makeRateLimitEvent(resetsAt?: string): Extract<GatewayEvent, { type: 'rate_limit' }> {
  return {
    type: 'rate_limit',
    session_id: 'sess-1',
    rate_limit_info: resetsAt ? { resets_at: resetsAt } : {},
  }
}

beforeEach(() => {
  vi.mocked(findAvailableIdentity).mockReset()
  vi.mocked(triggerGatewayDial).mockReset().mockResolvedValue(undefined)
  vi.mocked(updateState).mockReset()
  vi.mocked(persistMetaPatch).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('handleRateLimit', () => {
  it('cools down the current identity, broadcasts FailoverEvent, and dials resume when a successor exists', async () => {
    const d1 = makeFakeD1()
    // 1st first(): agent_sessions.identity_name lookup
    d1.firstQueue.push({ identity_name: 'work1' })
    // 2nd first(): runner_identities row by name
    d1.firstQueue.push({ id: 'id-w1', name: 'work1' })
    const { ctx, broadcast } = makeCtx(d1)
    vi.mocked(findAvailableIdentity).mockResolvedValue({
      id: 'id-w2',
      name: 'work2',
      home_path: '/srv/runners/work2',
    })

    await handleRateLimit(ctx, makeRateLimitEvent('2099-01-01T00:00:00.000Z'))

    // Cooldown UPDATE on runner_identities. calls[0] = SELECT identity_name,
    // calls[1] = SELECT runner_identities, calls[2] = UPDATE cooldown.
    expect(d1.calls.length).toBeGreaterThanOrEqual(3)
    const updateCall = d1.calls[2]
    expect(updateCall.sql).toMatch(/UPDATE\s+runner_identities/i)
    expect(updateCall.sql).toContain("status = 'cooldown'")
    expect(updateCall.sql).toContain('cooldown_until = datetime(?)')
    expect(updateCall.binds[0]).toBe('2099-01-01T00:00:00.000Z')
    expect(updateCall.binds[1]).toBe('id-w1')

    // updateState({status: 'failover', error: null, waiting_identity_retries: 0})
    expect(updateState).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ status: 'failover', error: null }),
    )

    // FailoverEvent broadcast
    expect(broadcast).toHaveBeenCalledTimes(1)
    const envelope = JSON.parse(broadcast.mock.calls[0][0])
    expect(envelope).toMatchObject({
      type: 'gateway_event',
      event: {
        type: 'failover',
        from_identity: 'work1',
        to_identity: 'work2',
        reason: 'rate_limit',
      },
    })

    // Resume dial fires with session_store_enabled:true so the new
    // identity reads the transcript from DO SQLite (not the prior
    // identity's local disk).
    expect(triggerGatewayDial).toHaveBeenCalledTimes(1)
    expect(triggerGatewayDial).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        type: 'resume',
        session_store_enabled: true,
        runner_session_id: 'sdk-abc',
        project: '/p',
        prompt: '',
      }),
    )
  })

  it('falls back to now+30min cooldown when resets_at is missing', async () => {
    vi.useFakeTimers()
    const fixedNow = new Date('2026-04-27T12:00:00.000Z').getTime()
    vi.setSystemTime(fixedNow)
    const d1 = makeFakeD1()
    d1.firstQueue.push({ identity_name: 'work1' })
    d1.firstQueue.push({ id: 'id-w1', name: 'work1' })
    const { ctx } = makeCtx(d1)
    vi.mocked(findAvailableIdentity).mockResolvedValue({
      id: 'id-w2',
      name: 'work2',
      home_path: '/srv/runners/work2',
    })

    await handleRateLimit(ctx, makeRateLimitEvent())

    const expected = new Date(fixedNow + 30 * 60_000).toISOString()
    const updateCall = d1.calls[2]
    expect(updateCall.binds[0]).toBe(expected)
  })

  it('falls back to +30min when resets_at is in the past', async () => {
    vi.useFakeTimers()
    const fixedNow = new Date('2026-04-27T12:00:00.000Z').getTime()
    vi.setSystemTime(fixedNow)
    const d1 = makeFakeD1()
    d1.firstQueue.push({ identity_name: 'work1' })
    d1.firstQueue.push({ id: 'id-w1', name: 'work1' })
    const { ctx } = makeCtx(d1)
    vi.mocked(findAvailableIdentity).mockResolvedValue({
      id: 'id-w2',
      name: 'work2',
      home_path: '/srv/runners/work2',
    })

    await handleRateLimit(ctx, makeRateLimitEvent('2000-01-01T00:00:00.000Z'))

    const expected = new Date(fixedNow + 30 * 60_000).toISOString()
    expect(d1.calls[2].binds[0]).toBe(expected)
  })

  it('enters waiting_identity + arms 60s alarm when no successor identity is available', async () => {
    vi.useFakeTimers()
    const fixedNow = new Date('2026-04-27T12:00:00.000Z').getTime()
    vi.setSystemTime(fixedNow)
    const d1 = makeFakeD1()
    d1.firstQueue.push({ identity_name: 'work1' })
    d1.firstQueue.push({ id: 'id-w1', name: 'work1' })
    const { ctx, broadcast, setAlarm } = makeCtx(d1)
    vi.mocked(findAvailableIdentity).mockResolvedValue(null)

    await handleRateLimit(ctx, makeRateLimitEvent('2099-01-01T00:00:00.000Z'))

    // Status flips to waiting_identity with retries=0 (initial entry).
    expect(updateState).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        status: 'waiting_identity',
        waiting_identity_retries: 0,
        error: 'All identities on cooldown — retrying',
      }),
    )
    // No FailoverEvent (no successor to fail over to).
    expect(broadcast).not.toHaveBeenCalled()
    // No resume dial.
    expect(triggerGatewayDial).not.toHaveBeenCalled()
    // Alarm armed for now+60s.
    expect(setAlarm).toHaveBeenCalledTimes(1)
    expect(setAlarm).toHaveBeenCalledWith(fixedNow + 60_000)
  })

  it('bails silently when no current identity is attached to the session', async () => {
    const d1 = makeFakeD1()
    // agent_sessions row with identity_name=null → loadCurrentIdentity returns null.
    d1.firstQueue.push({ identity_name: null })
    const { ctx, broadcast, setAlarm, logEvent } = makeCtx(d1)

    await handleRateLimit(ctx, makeRateLimitEvent('2099-01-01T00:00:00.000Z'))

    // No UPDATE on runner_identities, no second SELECT — only the initial
    // agent_sessions lookup.
    expect(d1.calls.length).toBe(1)
    expect(d1.calls[0].sql).toMatch(/SELECT identity_name FROM agent_sessions/)
    // No state change, no broadcast, no resume, no alarm.
    expect(updateState).not.toHaveBeenCalled()
    expect(persistMetaPatch).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    expect(triggerGatewayDial).not.toHaveBeenCalled()
    expect(setAlarm).not.toHaveBeenCalled()
    // Log the skip path so prod observability stays useful.
    expect(logEvent).toHaveBeenCalledWith(
      'info',
      'failover',
      expect.stringContaining('no current identity attached'),
    )
  })

  it('forwards reason="auth_error" onto the broadcast FailoverEvent', async () => {
    const d1 = makeFakeD1()
    d1.firstQueue.push({ identity_name: 'work1' })
    d1.firstQueue.push({ id: 'id-w1', name: 'work1' })
    const { ctx, broadcast } = makeCtx(d1)
    vi.mocked(findAvailableIdentity).mockResolvedValue({
      id: 'id-w2',
      name: 'work2',
      home_path: '/srv/runners/work2',
    })

    await handleRateLimit(ctx, makeRateLimitEvent('2099-01-01T00:00:00.000Z'), 'auth_error')

    expect(broadcast).toHaveBeenCalledTimes(1)
    const envelope = JSON.parse(broadcast.mock.calls[0][0])
    expect(envelope.event.reason).toBe('auth_error')
    expect(envelope.event.type).toBe('failover')
  })
})

describe('checkWaitingIdentity', () => {
  it('bails when status is not waiting_identity', async () => {
    const d1 = makeFakeD1()
    const { ctx, setAlarm } = makeCtx(d1, { status: 'running' })

    await checkWaitingIdentity(ctx)

    // No D1 read, no state mutation, no alarm.
    expect(d1.calls.length).toBe(0)
    expect(updateState).not.toHaveBeenCalled()
    expect(persistMetaPatch).not.toHaveBeenCalled()
    expect(setAlarm).not.toHaveBeenCalled()
    expect(findAvailableIdentity).not.toHaveBeenCalled()
  })

  it('recovers via failover dial when an identity becomes available', async () => {
    const d1 = makeFakeD1()
    // checkWaitingIdentity → loadCurrentIdentity reads agent_sessions then runner_identities.
    d1.firstQueue.push({ identity_name: 'work1' })
    d1.firstQueue.push({ id: 'id-w1', name: 'work1' })
    const { ctx, broadcast, setAlarm } = makeCtx(d1, {
      status: 'waiting_identity',
      waiting_identity_retries: 5,
    })
    vi.mocked(findAvailableIdentity).mockResolvedValue({
      id: 'id-w2',
      name: 'work2',
      home_path: '/srv/runners/work2',
    })

    await checkWaitingIdentity(ctx)

    // Status flips to failover, retries reset to 0.
    expect(updateState).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        status: 'failover',
        waiting_identity_retries: 0,
        error: null,
      }),
    )
    // FailoverEvent broadcast (previous identity name resolved via
    // loadCurrentIdentity).
    expect(broadcast).toHaveBeenCalledTimes(1)
    const envelope = JSON.parse(broadcast.mock.calls[0][0])
    expect(envelope.event).toMatchObject({
      type: 'failover',
      from_identity: 'work1',
      to_identity: 'work2',
      reason: 'rate_limit',
    })
    // Resume dial fires.
    expect(triggerGatewayDial).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        type: 'resume',
        session_store_enabled: true,
        runner_session_id: 'sdk-abc',
        project: '/p',
      }),
    )
    // No alarm re-armed — recovery succeeded.
    expect(setAlarm).not.toHaveBeenCalled()
  })

  it('bumps retries + re-arms alarm when no identity is available yet', async () => {
    vi.useFakeTimers()
    const fixedNow = new Date('2026-04-27T12:00:00.000Z').getTime()
    vi.setSystemTime(fixedNow)
    const d1 = makeFakeD1()
    const { ctx, setAlarm } = makeCtx(d1, {
      status: 'waiting_identity',
      waiting_identity_retries: 10,
    })
    vi.mocked(findAvailableIdentity).mockResolvedValue(null)

    await checkWaitingIdentity(ctx)

    // Counter bumped via persistMetaPatch (status stays waiting_identity).
    expect(persistMetaPatch).toHaveBeenCalledWith(ctx, { waiting_identity_retries: 11 })
    // Alarm rearmed at +60s.
    expect(setAlarm).toHaveBeenCalledTimes(1)
    expect(setAlarm).toHaveBeenCalledWith(fixedNow + 60_000)
    // No status flip via updateState — handler avoids spamming a no-op
    // status transition broadcast on every miss.
    expect(updateState).not.toHaveBeenCalled()
    // No resume dial, no broadcast.
    expect(triggerGatewayDial).not.toHaveBeenCalled()
  })

  it('declares the session failed after WAITING_IDENTITY_MAX_RETRIES (30) misses', async () => {
    const d1 = makeFakeD1()
    const { ctx, setAlarm } = makeCtx(d1, {
      status: 'waiting_identity',
      waiting_identity_retries: 30,
    })

    await checkWaitingIdentity(ctx)

    // Terminal failure: status flips to error with the canonical message.
    expect(updateState).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        status: 'error',
        error: 'All identities exhausted after 30min',
      }),
    )
    // No alarm rearmed.
    expect(setAlarm).not.toHaveBeenCalled()
    // No new identity lookup or dial.
    expect(findAvailableIdentity).not.toHaveBeenCalled()
    expect(triggerGatewayDial).not.toHaveBeenCalled()
  })
})
