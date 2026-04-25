import type { RateLimitEvent, SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import { describe, expect, it } from 'vitest'
import {
  NO_PROFILE_FALLBACK_DELAY_MS,
  planPendingResumeDispatch,
  planRateLimitAction,
  ROTATION_RESUME_SLOP_MS,
  serializeHistoryForFork,
  WAITING_PROFILE_RESUME_SLOP_MS,
} from './session-do-helpers'

/**
 * GH#92 P3: caam rate-limit handling + forkWithHistory transcript filter.
 *
 * The SessionDO class can't be imported into vitest (TC39 decorators on
 * `@callable` methods break oxc's parser — see the comment in
 * `session-do.test.ts`). The same mitigation that file uses applies here:
 * the rate_limit branch decisions, alarm-prefix dispatch decision, and
 * forkWithHistory transcript serializer all live as pure helpers in
 * `session-do-helpers.ts`. The DO method calls the helper then executes
 * the returned plan via existing side-effect helpers
 * (insertSystemBreadcrumb / updateState / scheduleResumeAlarm /
 * syncStatusAndErrorToD1 / triggerGatewayDial). Asserting on the helpers
 * exercises the real production path without weakening the DO's
 * encapsulation.
 */

describe('planRateLimitAction (do-rate-limited-breadcrumb)', () => {
  it('rotated: emits caam-rotated breadcrumb + pendingResume at now+1s', () => {
    const now = 1_700_000_000_000
    const event: RateLimitEvent = {
      type: 'rate_limit',
      session_id: 'test-session',
      rate_limit_info: {},
      exit_reason: 'rate_limited',
      rotation: { from: 'work1', to: 'work2' },
      resets_at: null,
    }
    const plan = planRateLimitAction({ event, now })
    expect(plan.kind).toBe('rotated')
    if (plan.kind !== 'rotated') return // narrow

    expect(plan.breadcrumb.metadata.caam).toEqual({
      kind: 'rotated',
      from: 'work1',
      to: 'work2',
      at: now,
    })
    expect(plan.pendingResume.kind).toBe('rotation')
    expect(plan.pendingResume.at).toBe(now + ROTATION_RESUME_SLOP_MS)
    // The DO's executor calls scheduleResumeAlarm(plan.pendingResume.at)
    // and updateState({ pendingResume: plan.pendingResume }) — both pure
    // forwards of values asserted above.
  })

  it('rotated: omits caam-rotation breadcrumb when rotation is null', () => {
    const event: RateLimitEvent = {
      type: 'rate_limit',
      session_id: 'test-session',
      rate_limit_info: {},
      exit_reason: 'rate_limited',
      rotation: null,
      resets_at: null,
    }
    const plan = planRateLimitAction({ event, now: 1 })
    expect(plan.kind).toBe('rotation_missing')
  })
})

describe('planRateLimitAction (do-no-rotate-error)', () => {
  it('skipped: emits caam-skipped breadcrumb + terminal error, no pendingResume', () => {
    const now = 1_700_000_000_000
    const event: RateLimitEvent = {
      type: 'rate_limit',
      session_id: 'test-session',
      rate_limit_info: {},
      exit_reason: 'rate_limited_no_rotate',
      rotation: null,
    }
    const plan = planRateLimitAction({ event, now })
    expect(plan.kind).toBe('skipped')
    if (plan.kind !== 'skipped') return // narrow

    expect(plan.breadcrumb.metadata.caam).toEqual({ kind: 'skipped', at: now })
    expect(plan.terminalError).toMatch(/rotation skipped/i)
    // No `pendingResume` field on the discriminated variant — the DO
    // executor flips status='error' and never calls scheduleResumeAlarm
    // for this branch.
    expect((plan as Record<string, unknown>).pendingResume).toBeUndefined()
  })
})

describe('planRateLimitAction (do-waiting-profile-status)', () => {
  it('waiting: pendingResume.at = earliest_clear_ts + 30_000 slop', () => {
    const now = 1_700_000_000_000
    const earliestClearTs = now + 60 * 60 * 1_000 // +1h
    const event: RateLimitEvent = {
      type: 'rate_limit',
      session_id: 'test-session',
      rate_limit_info: {},
      exit_reason: 'rate_limited_no_profile',
      earliest_clear_ts: earliestClearTs,
    }
    const plan = planRateLimitAction({ event, now })
    expect(plan.kind).toBe('waiting')
    if (plan.kind !== 'waiting') return // narrow

    expect(plan.breadcrumb.metadata.caam).toEqual({
      kind: 'waiting',
      at: now,
      earliest_clear_ts: earliestClearTs,
    })
    expect(plan.pendingResume.at).toBe(earliestClearTs + WAITING_PROFILE_RESUME_SLOP_MS)
    expect(plan.fallbackUsed).toBe(false)
  })

  it('waiting: missing earliest_clear_ts falls back to now + 60s', () => {
    const now = 1_700_000_000_000
    const event: RateLimitEvent = {
      type: 'rate_limit',
      session_id: 'test-session',
      rate_limit_info: {},
      exit_reason: 'rate_limited_no_profile',
    }
    const plan = planRateLimitAction({ event, now })
    expect(plan.kind).toBe('waiting')
    if (plan.kind !== 'waiting') return

    expect(plan.fallbackUsed).toBe(true)
    expect(plan.earliestClearTs).toBe(now + NO_PROFILE_FALLBACK_DELAY_MS)
    expect(plan.pendingResume.at).toBe(
      now + NO_PROFILE_FALLBACK_DELAY_MS + WAITING_PROFILE_RESUME_SLOP_MS,
    )
  })

  it('degraded: no exit_reason → no breadcrumb / no resume schedule', () => {
    const event: RateLimitEvent = {
      type: 'rate_limit',
      session_id: 'test-session',
      rate_limit_info: {},
    }
    const plan = planRateLimitAction({ event, now: 1 })
    expect(plan.kind).toBe('degraded')
  })
})

describe('planPendingResumeDispatch (do-alarm-resumes-after-pendingresume)', () => {
  it('dispatches resume when pendingResume is due and no runner is attached', () => {
    const now = 1_700_000_000_000
    const plan = planPendingResumeDispatch({
      pendingResume: { kind: 'rotation', at: now - 1_000 }, // already past
      now,
      hasRunner: false,
      sdkSessionId: 'sdk-abc',
      project: '/data/projects/foo',
    })
    expect(plan.kind).toBe('dispatch')
    if (plan.kind !== 'dispatch') return

    expect(plan.sdkSessionId).toBe('sdk-abc')
    expect(plan.project).toBe('/data/projects/foo')
  })

  it('noop when pendingResume is null (idempotent — second alarm tick)', () => {
    const plan = planPendingResumeDispatch({
      pendingResume: null,
      now: 1_700_000_000_000,
      hasRunner: false,
      sdkSessionId: 'sdk-abc',
      project: '/data/projects/foo',
    })
    expect(plan.kind).toBe('noop')
  })

  it('noop when pendingResume is in the future', () => {
    const now = 1_700_000_000_000
    const plan = planPendingResumeDispatch({
      pendingResume: { kind: 'rotation', at: now + 5_000 },
      now,
      hasRunner: false,
      sdkSessionId: 'sdk-abc',
      project: '/data/projects/foo',
    })
    expect(plan.kind).toBe('noop')
  })

  it('clear_only when pendingResume is due but a runner is already attached', () => {
    const now = 1_700_000_000_000
    const plan = planPendingResumeDispatch({
      pendingResume: { kind: 'rotation', at: now - 1_000 },
      now,
      hasRunner: true,
      sdkSessionId: 'sdk-abc',
      project: '/data/projects/foo',
    })
    expect(plan.kind).toBe('clear_only')
  })

  it('clear_missing_context when sdk_session_id is null', () => {
    const now = 1_700_000_000_000
    const plan = planPendingResumeDispatch({
      pendingResume: { kind: 'rotation', at: now - 1_000 },
      now,
      hasRunner: false,
      sdkSessionId: null,
      project: '/data/projects/foo',
    })
    expect(plan.kind).toBe('clear_missing_context')
  })
})

describe('serializeHistoryForFork (do-breadcrumb-filter-serializer)', () => {
  it('drops system-role caam breadcrumbs, preserves user/assistant turn order', () => {
    const history: WireSessionMessage[] = [
      { id: '1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
      {
        id: '3',
        role: 'system',
        parts: [{ type: 'text', text: '⚡ rotated' }],
        metadata: { caam: { kind: 'rotated', at: 0 } },
      },
      { id: '4', role: 'user', parts: [{ type: 'text', text: 'follow-up' }] },
    ]
    const transcript = serializeHistoryForFork(history)

    // Exactly three turns survive (the caam breadcrumb is dropped).
    const lines = transcript.split('\n\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('User: hello')
    expect(lines[1]).toBe('Assistant: hi')
    expect(lines[2]).toBe('User: follow-up')

    // Negative assertion: the breadcrumb body never made it through.
    expect(transcript).not.toContain('⚡ rotated')
  })

  it('returns "" when every turn is a caam breadcrumb (caller skips wrapper)', () => {
    const history: WireSessionMessage[] = [
      {
        id: '1',
        role: 'system',
        parts: [{ type: 'text', text: '⚡ rotated' }],
        metadata: { caam: { kind: 'rotated', at: 0 } },
      },
    ]
    expect(serializeHistoryForFork(history)).toBe('')
  })

  it('renders tool-* parts as [used tool: <name>]', () => {
    const history: WireSessionMessage[] = [
      {
        id: '1',
        role: 'assistant',
        parts: [{ type: 'tool-Bash', toolName: 'Bash' }],
      },
    ]
    expect(serializeHistoryForFork(history)).toBe('Assistant: [used tool: Bash]')
  })

  it('renders reasoning parts with [thinking] prefix', () => {
    const history: WireSessionMessage[] = [
      {
        id: '1',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'planning' }],
      },
    ]
    expect(serializeHistoryForFork(history)).toBe('Assistant: [thinking] planning')
  })
})
