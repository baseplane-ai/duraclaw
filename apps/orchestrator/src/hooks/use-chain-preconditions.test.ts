/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

/**
 * Regression: the spec-status / vp-status routes require `?project=` —
 * before this fix the hook called them without it, the server returned
 * 400, `cachedFetch` silently coerced that into `{exists:false}`, and
 * every chain rendered "Spec not found" / "VP evidence not found"
 * regardless of worktree state.
 */
describe('checkPrecondition — project query param transmission', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function uniqueChain(overrides: Partial<ChainSummary>): ChainSummary {
    // Use a fresh issueNumber per test so the module-level cache (keyed
    // by `spec:${issue}:${project}`) doesn't bleed between cases.
    const issueNumber = Math.floor(Math.random() * 1_000_000) + 1_000_000
    return {
      issueNumber,
      issueTitle: 'project-param test',
      issueType: 'enhancement',
      issueState: 'open',
      column: 'planning',
      sessions: [],
      worktreeReservation: null,
      lastActivity: '2026-04-25T00:00:00Z',
      ...overrides,
    }
  }

  describe('planning → implementation (spec-status)', () => {
    it('passes ?project= derived from chain.sessions[0].project', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, status: 'approved' }), { status: 200 }),
      )
      const c = uniqueChain({
        column: 'planning',
        sessions: [
          {
            id: 's1',
            kataMode: 'planning',
            status: 'idle',
            lastActivity: '2026-04-25T00:00:00Z',
            createdAt: '2026-04-25T00:00:00Z',
            project: 'duraclaw-dev5',
          },
        ],
      })
      const res = await checkPrecondition(c, [])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain(`/api/chains/${c.issueNumber}/spec-status`)
      expect(url).toContain('project=duraclaw-dev5')
      expect(res).toEqual({ canAdvance: true, reason: '', nextMode: 'implementation' })
    })

    it('falls back to worktreeReservation.path basename when no sessions present', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, status: 'approved' }), { status: 200 }),
      )
      const c = uniqueChain({
        column: 'planning',
        sessions: [],
        // GH#115 wire shape: chain summary projects the worktrees row
        // with `path` (full clone path); the precondition hook derives
        // the legacy project-name from the basename.
        worktreeReservation: {
          id: 'wt-xyz',
          path: '/data/projects/duraclaw-dev2',
          branch: null,
          status: 'held',
          reservedBy: { kind: 'arc', id: 27 },
          ownerId: 'u1',
          releasedAt: null,
          lastTouchedAt: Date.now(),
          stale: false,
        },
      })
      await checkPrecondition(c, [])
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('project=duraclaw-dev2')
    })

    it('blocks with a clear reason when no project context is available', async () => {
      const c = uniqueChain({ column: 'planning', sessions: [], worktreeReservation: null })
      const res = await checkPrecondition(c, [])
      expect(fetchMock).not.toHaveBeenCalled()
      expect(res.canAdvance).toBe(false)
      expect(res.reason).toContain('project context')
    })

    it('url-encodes worktree names with special characters', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, status: 'approved' }), { status: 200 }),
      )
      const c = uniqueChain({
        column: 'planning',
        sessions: [
          {
            id: 's1',
            kataMode: 'planning',
            status: 'idle',
            lastActivity: '2026-04-25T00:00:00Z',
            createdAt: '2026-04-25T00:00:00Z',
            project: 'name with space',
          },
        ],
      })
      await checkPrecondition(c, [])
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('project=name%20with%20space')
    })
  })

  describe('verify → close (vp-status)', () => {
    it('passes ?project= derived from chain.sessions[0].project', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, passed: true }), { status: 200 }),
      )
      const c = uniqueChain({
        column: 'verify',
        sessions: [
          {
            id: 's1',
            kataMode: 'verify',
            status: 'idle',
            lastActivity: '2026-04-25T00:00:00Z',
            createdAt: '2026-04-25T00:00:00Z',
            project: 'duraclaw',
          },
        ],
      })
      const res = await checkPrecondition(c, [])
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain(`/api/chains/${c.issueNumber}/vp-status`)
      expect(url).toContain('project=duraclaw')
      expect(res).toEqual({ canAdvance: true, reason: '', nextMode: 'close' })
    })

    it('blocks with a clear reason when no project context is available', async () => {
      const c = uniqueChain({ column: 'verify', sessions: [], worktreeReservation: null })
      const res = await checkPrecondition(c, [])
      expect(fetchMock).not.toHaveBeenCalled()
      expect(res.canAdvance).toBe(false)
      expect(res.reason).toContain('project context')
    })
  })

  /**
   * Regression: a transient gateway/network blip used to be cached as
   * `{exists:false}` for 30s, producing a sticky "Spec not found" stall
   * even after recovery. The fix only caches successful responses; the
   * second call after a failure must hit the network again.
   */
  describe('transient failures must not poison the cache', () => {
    function planningChain() {
      return uniqueChain({
        column: 'planning',
        sessions: [
          {
            id: 's1',
            kataMode: 'planning',
            status: 'idle',
            lastActivity: '2026-04-25T00:00:00Z',
            createdAt: '2026-04-25T00:00:00Z',
            project: 'duraclaw-dev6',
          },
        ],
      })
    }

    it('a 5xx response does NOT poison the cache — next call retries live', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('upstream gateway hiccup', { status: 502 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ exists: true, status: 'approved' }), { status: 200 }),
        )
      const c = planningChain()
      const first = await checkPrecondition(c, [])
      expect(first.canAdvance).toBe(false)
      expect(first.reason).toBe('Spec not found')
      // Second call must re-fetch (cache was NOT populated by the failure).
      const second = await checkPrecondition(c, [])
      expect(second.canAdvance).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('a network rejection does NOT poison the cache', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('network down'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ exists: true, status: 'approved' }), { status: 200 }),
        )
      const c = planningChain()
      const first = await checkPrecondition(c, [])
      expect(first.canAdvance).toBe(false)
      const second = await checkPrecondition(c, [])
      expect(second.canAdvance).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('a successful response IS cached (sanity — 30s TTL still applies)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, status: 'approved' }), { status: 200 }),
      )
      const c = planningChain()
      await checkPrecondition(c, [])
      await checkPrecondition(c, [])
      // Second call served from cache — only one fetch.
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})
