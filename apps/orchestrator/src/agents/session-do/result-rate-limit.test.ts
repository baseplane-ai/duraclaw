import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GH#119 P3: routing test for the `result` case in
 * `gateway-event-handler.ts`. The runner stamps `error: 'rate_limit'` /
 * `'authentication_failed'` on terminal results when the SDK reports
 * those failure modes; the DO must fan out to `handleRateLimit` so the
 * cooldown + failover state machine fires. Other `error` values (or no
 * error at all) must NOT route through failover — the existing
 * terminal-error pipeline handles them.
 *
 * We mock every collaborator of the gateway-event-handler module so the
 * test stays focused on the routing decision and doesn't require a real
 * Session / DO / D1.
 */

vi.mock('./resume-scheduler', () => ({
  handleRateLimit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./status', () => ({
  syncResultToD1: vi.fn().mockResolvedValue(undefined),
  syncRunnerSessionIdToD1: vi.fn().mockResolvedValue(undefined),
  syncCapabilitiesToD1: vi.fn().mockResolvedValue(undefined),
  syncKataAllToD1: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./broadcast', () => ({
  broadcastMessages: vi.fn(),
}))

vi.mock('./runner-link', () => ({
  sendToGateway: vi.fn(),
}))

vi.mock('./title', () => ({
  handleTitleUpdate: vi.fn(),
}))

vi.mock('./gates', () => ({
  promoteToolPartToGate: vi.fn(),
}))

vi.mock('./transcript', () => ({
  appendTranscriptImpl: vi.fn(),
  loadTranscriptImpl: vi.fn(),
  listTranscriptSubkeysImpl: vi.fn(),
  deleteTranscriptImpl: vi.fn(),
}))

vi.mock('~/lib/broadcast-session', () => ({
  broadcastSessionRow: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('~/lib/action-token', () => ({
  generateActionToken: vi.fn().mockResolvedValue('test-token'),
}))

import type { ResultEvent } from '@duraclaw/shared-types'
import type { GatewayEvent } from '~/lib/types'
import { handleGatewayEvent } from './gateway-event-handler'
import { handleRateLimit } from './resume-scheduler'
import type { SessionDOContext } from './types'

function makeCtx() {
  // Self (DO) stub — only the methods the `result` case touches.
  const self = {
    name: 'sess-1',
    turnCounter: 0,
    currentTurnMessageId: null as string | null,
    clearAwaitingResponse: vi.fn(),
    safeAppendMessage: vi.fn(),
    safeUpdateMessage: vi.fn(),
    persistTurnState: vi.fn(),
    updateState: vi.fn(),
    dispatchPush: vi.fn().mockResolvedValue(undefined),
  }
  const ctx = {
    do: self,
    state: {
      status: 'running',
      project: '/p',
      session_id: 'sess-1',
      num_turns: 0,
      total_cost_usd: 0,
      duration_ms: 0,
      summary: null,
      capabilities: null,
    },
    session: {
      // No prior message — both safeUpdateMessage paths short-circuit.
      getMessage: vi.fn().mockReturnValue(undefined),
      getHistory: vi.fn().mockReturnValue([]),
    },
    ctx: {
      id: { toString: () => 'do-id-x' },
      // Eat waitUntil promises so the dispatchPush side effects don't
      // produce unhandled rejections.
      waitUntil: (_p: Promise<unknown>) => {},
    },
    env: {},
    logEvent: vi.fn(),
    broadcast: vi.fn(),
  } as unknown as SessionDOContext
  return ctx
}

function makeResultEvent(overrides: Partial<ResultEvent> = {}): GatewayEvent {
  const base: ResultEvent = {
    type: 'result',
    session_id: 'sess-1',
    subtype: 'success',
    duration_ms: 100,
    total_cost_usd: 0,
    result: 'done',
    num_turns: 1,
    is_error: false,
    sdk_summary: null,
    ...overrides,
  }
  return base as GatewayEvent
}

describe('handleGatewayEvent — result case → handleRateLimit routing', () => {
  beforeEach(() => {
    vi.mocked(handleRateLimit).mockClear()
  })

  it('routes error="rate_limit" through handleRateLimit with reason="rate_limit"', () => {
    const ctx = makeCtx()
    handleGatewayEvent(
      ctx,
      makeResultEvent({ is_error: true, error: 'rate_limit', result: 'rate limit hit' }),
    )

    expect(handleRateLimit).toHaveBeenCalledTimes(1)
    const [calledCtx, synthEvent, reason] = vi.mocked(handleRateLimit).mock.calls[0]
    expect(calledCtx).toBe(ctx)
    expect(synthEvent).toMatchObject({
      type: 'rate_limit',
      session_id: 'sess-1',
      rate_limit_info: {},
    })
    expect(reason).toBe('rate_limit')
  })

  it('routes error="authentication_failed" through handleRateLimit with reason="auth_error"', () => {
    const ctx = makeCtx()
    handleGatewayEvent(
      ctx,
      makeResultEvent({
        is_error: true,
        error: 'authentication_failed',
        result: 'auth failed',
      }),
    )

    expect(handleRateLimit).toHaveBeenCalledTimes(1)
    const reason = vi.mocked(handleRateLimit).mock.calls[0][2]
    expect(reason).toBe('auth_error')
  })

  it('does NOT route arbitrary error values through handleRateLimit', () => {
    const ctx = makeCtx()
    handleGatewayEvent(
      ctx,
      makeResultEvent({ is_error: true, error: 'something_else', result: 'oops' }),
    )
    expect(handleRateLimit).not.toHaveBeenCalled()
  })

  it('does NOT route a successful result (no error) through handleRateLimit', () => {
    const ctx = makeCtx()
    handleGatewayEvent(ctx, makeResultEvent({ is_error: false, result: 'ok' }))
    expect(handleRateLimit).not.toHaveBeenCalled()
  })

  it('does NOT route when error is undefined even on is_error=true', () => {
    const ctx = makeCtx()
    handleGatewayEvent(ctx, makeResultEvent({ is_error: true, error: undefined, result: 'oops' }))
    expect(handleRateLimit).not.toHaveBeenCalled()
  })
})
