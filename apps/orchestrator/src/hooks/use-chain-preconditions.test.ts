/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'

import type { ChainSummary } from '~/lib/types'
import { checkPrecondition } from './use-chain-preconditions'

/**
 * GH#82 scenario-3 regression: the manual-advance gate used to check
 * `session.status === 'completed'`, which is permanently false because
 * `SessionStatus` has no 'completed' variant. Finished rungs park as
 * 'idle' with a non-null `lastActivity`. These tests pin the corrected
 * behaviour (via `isChainSessionCompleted`) so it doesn't regress.
 */

function chain(overrides: Partial<ChainSummary>): ChainSummary {
  return {
    issueNumber: 82,
    issueTitle: 'test chain',
    issueType: 'bug',
    issueState: 'open',
    column: 'research',
    sessions: [],
    worktreeReservation: null,
    lastActivity: '2026-04-24T00:00:00Z',
    ...overrides,
  }
}

describe('checkPrecondition — manual-advance gates (GH#82)', () => {
  describe('research → planning', () => {
    it('allows advance when a prior research session parked as idle with activity', async () => {
      const c = chain({ column: 'research' })
      const res = await checkPrecondition(c, [
        { kataMode: 'research', status: 'idle', lastActivity: '2026-04-24T12:00:00Z' },
      ])
      expect(res).toEqual({ canAdvance: true, reason: '', nextMode: 'planning' })
    })

    it('blocks when the research session is still running', async () => {
      const c = chain({ column: 'research' })
      const res = await checkPrecondition(c, [
        { kataMode: 'research', status: 'running', lastActivity: '2026-04-24T12:00:00Z' },
      ])
      expect(res.canAdvance).toBe(false)
      expect(res.reason).toContain('No completed research')
      expect(res.nextMode).toBe('planning')
    })

    it('blocks when an idle research session never ran (no lastActivity)', async () => {
      const c = chain({ column: 'research' })
      const res = await checkPrecondition(c, [
        { kataMode: 'research', status: 'idle', lastActivity: null },
      ])
      expect(res.canAdvance).toBe(false)
    })
  })

  describe('implementation → verify', () => {
    it('allows advance when implementation parked as idle with activity', async () => {
      const c = chain({ column: 'implementation' })
      const res = await checkPrecondition(c, [
        { kataMode: 'implementation', status: 'idle', lastActivity: '2026-04-24T12:00:00Z' },
      ])
      expect(res.canAdvance).toBe(true)
      expect(res.nextMode).toBe('verify')
    })

    it('blocks when implementation is mid-turn (waiting_input)', async () => {
      const c = chain({ column: 'implementation' })
      const res = await checkPrecondition(c, [
        {
          kataMode: 'implementation',
          status: 'waiting_input',
          lastActivity: '2026-04-24T12:00:00Z',
        },
      ])
      expect(res.canAdvance).toBe(false)
      expect(res.reason).toContain('No completed implementation')
    })
  })

  describe('backlog → research', () => {
    it('allows advance on an open issue even with zero prior sessions', async () => {
      const c = chain({ column: 'backlog', issueState: 'open' })
      const res = await checkPrecondition(c, [])
      expect(res.canAdvance).toBe(true)
      expect(res.nextMode).toBe('research')
    })

    it('blocks when the GitHub issue is closed', async () => {
      const c = chain({ column: 'backlog', issueState: 'closed' })
      const res = await checkPrecondition(c, [])
      expect(res.canAdvance).toBe(false)
      expect(res.reason).toContain('closed')
    })
  })
})
