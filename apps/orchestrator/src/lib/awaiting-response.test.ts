/**
 * Spec #80 P1 unit tests — the `buildAwaitingPart` helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAwaitingPart } from './awaiting-response'

describe('buildAwaitingPart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a part with the spec-defined shape (first_token)', () => {
    vi.setSystemTime(1_700_000_000_000)
    const part = buildAwaitingPart('first_token')
    expect(part).toEqual({
      type: 'awaiting_response',
      state: 'pending',
      reason: 'first_token',
      startedTs: 1_700_000_000_000,
    })
  })

  it('threads the reason through for each reserved variant', () => {
    for (const reason of ['first_token', 'subagent', 'monitor', 'async_wake'] as const) {
      const part = buildAwaitingPart(reason)
      expect(part.reason).toBe(reason)
      expect(part.type).toBe('awaiting_response')
      expect(part.state).toBe('pending')
    }
  })

  it('stamps startedTs with Date.now() at invocation time', () => {
    vi.setSystemTime(1_000)
    const early = buildAwaitingPart('first_token')
    vi.advanceTimersByTime(5_000)
    const later = buildAwaitingPart('first_token')
    expect(early.startedTs).toBe(1_000)
    expect(later.startedTs).toBe(6_000)
  })
})
