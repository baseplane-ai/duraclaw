import { describe, expect, it } from 'vitest'
import {
  buildChainRowFromContext,
  type ChainBuildContext,
  deriveColumn,
  deriveIssueType,
  findPrForIssue,
  isChainSessionCompleted,
} from './chains'

/**
 * Pure-function unit tests for the chain aggregation helpers. Covers:
 *   - empty chain → null (no sessions, no GH issue)
 *   - single session → correct ChainSummary shape
 *   - multi-session aggregation (lastActivity + column derivation)
 *   - lane/type derivation from GH labels
 *   - PR matching by branch pattern and body tokens
 *
 * The async `buildChainRow(env, db, …)` wrapper is covered indirectly
 * (and by integration via session-do.test.ts) — it composes the same
 * `buildChainRowFromContext` over live Drizzle results plus the GH cache.
 */

describe('deriveIssueType', () => {
  it('returns "bug" when labels contain bug', () => {
    expect(deriveIssueType([{ name: 'bug' }, { name: 'enhancement' }])).toBe('bug')
  })
  it('prefers bug over enhancement', () => {
    expect(deriveIssueType([{ name: 'enhancement' }, { name: 'bug' }])).toBe('bug')
  })
  it('returns "enhancement" when only enhancement', () => {
    expect(deriveIssueType([{ name: 'enhancement' }])).toBe('enhancement')
  })
  it('returns "other" for unknown labels', () => {
    expect(deriveIssueType([{ name: 'area/ui' }])).toBe('other')
  })
  it('handles undefined labels', () => {
    expect(deriveIssueType(undefined)).toBe('other')
  })
})

describe('isChainSessionCompleted', () => {
  // GH#82 regression: agent_sessions.status NEVER holds 'completed' in this
  // codebase (the SessionStatus union is idle/pending/running/waiting_*/error).
  // Finished rungs park as 'idle' with a non-null lastActivity. Every
  // `status === 'completed'` check in the prior code was permanently false;
  // this predicate is the canonical replacement.
  it('returns true for an idle session with a lastActivity timestamp', () => {
    expect(isChainSessionCompleted({ status: 'idle', lastActivity: '2026-04-24T12:00:00Z' })).toBe(
      true,
    )
  })
  it('returns false for an idle session that never ran (no lastActivity)', () => {
    expect(isChainSessionCompleted({ status: 'idle', lastActivity: null })).toBe(false)
  })
  it('returns false for a running session even with lastActivity', () => {
    expect(
      isChainSessionCompleted({ status: 'running', lastActivity: '2026-04-24T12:00:00Z' }),
    ).toBe(false)
  })
  it('returns false for waiting_* and error statuses', () => {
    for (const status of ['waiting_input', 'waiting_permission', 'waiting_gate', 'error']) {
      expect(isChainSessionCompleted({ status, lastActivity: '2026-04-24T12:00:00Z' })).toBe(false)
    }
  })
  it('returns false for the literal "completed" string (defensive — not in the union)', () => {
    // If any upstream surface ever starts writing 'completed' we should
    // still gate on lastActivity; but for now treat as unrecognised.
    expect(
      isChainSessionCompleted({ status: 'completed', lastActivity: '2026-04-24T12:00:00Z' }),
    ).toBe(false)
  })
})

describe('deriveColumn', () => {
  it('returns "done" for closed issues regardless of sessions', () => {
    expect(deriveColumn([], 'closed')).toBe('done')
    expect(
      deriveColumn(
        [{ kataMode: 'verify', lastActivity: '2026-01-01', createdAt: '2026-01-01' }],
        'closed',
      ),
    ).toBe('done')
  })
  it('returns "backlog" with no sessions on open issue', () => {
    expect(deriveColumn([], 'open')).toBe('backlog')
  })
  it('picks latest qualifying session mode', () => {
    const sessions = [
      { kataMode: 'planning', lastActivity: '2026-01-01T00:00:00Z', createdAt: '2026-01-01' },
      { kataMode: 'implementation', lastActivity: '2026-01-02T00:00:00Z', createdAt: '2026-01-02' },
    ]
    expect(deriveColumn(sessions, 'open')).toBe('implementation')
  })
  it('skips non-qualifying modes like debug/freeform', () => {
    const sessions = [
      { kataMode: 'research', lastActivity: '2026-01-01T00:00:00Z', createdAt: '2026-01-01' },
      { kataMode: 'debug', lastActivity: '2026-01-02T00:00:00Z', createdAt: '2026-01-02' },
    ]
    expect(deriveColumn(sessions, 'open')).toBe('research')
  })
})

describe('findPrForIssue', () => {
  it('matches by branch pattern feature/N-…', () => {
    const pulls = [{ number: 42, head: { ref: 'feature/27-synced-collections' } }]
    expect(findPrForIssue(pulls, 27)).toBe(42)
  })
  it('matches by body Closes #N', () => {
    const pulls = [{ number: 42, head: { ref: 'branch' }, body: 'This PR closes #27 finally.' }]
    expect(findPrForIssue(pulls, 27)).toBe(42)
  })
  it('does not cross-match #270 for issue #27', () => {
    const pulls = [{ number: 42, head: { ref: 'branch' }, body: 'Closes #270' }]
    expect(findPrForIssue(pulls, 27)).toBeUndefined()
  })
  it('returns undefined when no match', () => {
    expect(findPrForIssue([], 27)).toBeUndefined()
  })
})

// ─── buildChainRowFromContext ───────────────────────────────────────────────

const emptyCtx: ChainBuildContext = { ghIssueByNumber: new Map(), pulls: [] }

function ctxWithIssue(
  issueNumber: number,
  partial: Partial<{
    title: string
    state: 'open' | 'closed'
    labels: Array<{ name: string }>
    updated_at: string
  }> = {},
): ChainBuildContext {
  return {
    ghIssueByNumber: new Map([
      [
        issueNumber,
        {
          number: issueNumber,
          title: partial.title ?? `Title #${issueNumber}`,
          state: partial.state ?? 'open',
          labels: partial.labels,
          updated_at: partial.updated_at,
        },
      ],
    ]),
    pulls: [],
  }
}

describe('buildChainRowFromContext', () => {
  it('returns null when there are no sessions and no GH issue', () => {
    const row = buildChainRowFromContext(99, [], null, emptyCtx)
    expect(row).toBeNull()
  })

  it('builds a row for a single session with GH metadata', () => {
    const ctx = ctxWithIssue(27, { title: 'Sync collections', labels: [{ name: 'enhancement' }] })
    const row = buildChainRowFromContext(
      27,
      [
        {
          id: 'sess-1',
          kataMode: 'implementation',
          status: 'running',
          lastActivity: '2026-04-20T10:00:00Z',
          createdAt: '2026-04-20T09:00:00Z',
          project: 'duraclaw-dev3',
        },
      ],
      null,
      ctx,
    )
    expect(row).not.toBeNull()
    expect(row!.issueNumber).toBe(27)
    expect(row!.issueTitle).toBe('Sync collections')
    expect(row!.issueType).toBe('enhancement')
    expect(row!.issueState).toBe('open')
    expect(row!.column).toBe('implementation')
    expect(row!.sessions).toHaveLength(1)
    expect(row!.sessions[0].id).toBe('sess-1')
    expect(row!.lastActivity).toBe('2026-04-20T10:00:00Z')
    expect(row!.worktreeReservation).toBeNull()
    expect(row!.prNumber).toBeUndefined()
  })

  it('aggregates lastActivity across multiple sessions for same issue', () => {
    const ctx = ctxWithIssue(27)
    const row = buildChainRowFromContext(
      27,
      [
        {
          id: 's1',
          kataMode: 'planning',
          status: 'idle',
          lastActivity: '2026-04-10T00:00:00Z',
          createdAt: '2026-04-10T00:00:00Z',
          project: 'p',
        },
        {
          id: 's2',
          kataMode: 'implementation',
          status: 'running',
          lastActivity: '2026-04-15T00:00:00Z',
          createdAt: '2026-04-14T00:00:00Z',
          project: 'p',
        },
        {
          id: 's3',
          kataMode: 'verify',
          status: 'idle',
          lastActivity: null,
          createdAt: '2026-04-12T00:00:00Z',
          project: 'p',
        },
      ],
      null,
      ctx,
    )
    expect(row!.sessions).toHaveLength(3)
    expect(row!.lastActivity).toBe('2026-04-15T00:00:00Z')
    // Latest qualifying mode → verify is on 04-12, implementation on 04-15 → implementation.
    expect(row!.column).toBe('implementation')
  })

  it('falls back to "Issue #N" when GH issue is missing but sessions exist', () => {
    const row = buildChainRowFromContext(
      77,
      [
        {
          id: 's1',
          kataMode: null,
          status: 'idle',
          lastActivity: null,
          createdAt: '2026-04-01T00:00:00Z',
          project: 'p',
        },
      ],
      null,
      emptyCtx,
    )
    expect(row).not.toBeNull()
    expect(row!.issueTitle).toBe('Issue #77')
    expect(row!.issueState).toBe('open')
    expect(row!.issueType).toBe('other')
  })

  it('includes worktreeReservation when present', () => {
    const row = buildChainRowFromContext(
      27,
      [
        {
          id: 's1',
          kataMode: 'implementation',
          status: 'idle',
          lastActivity: '2026-04-20T00:00:00Z',
          createdAt: '2026-04-20T00:00:00Z',
          project: 'p',
        },
      ],
      {
        worktree: 'duraclaw-dev3',
        heldSince: '2026-04-18T00:00:00Z',
        lastActivityAt: '2026-04-20T00:00:00Z',
        ownerId: 'user-1',
        stale: false,
      },
      emptyCtx,
    )
    expect(row!.worktreeReservation).toEqual({
      worktree: 'duraclaw-dev3',
      heldSince: '2026-04-18T00:00:00Z',
      lastActivityAt: '2026-04-20T00:00:00Z',
      ownerId: 'user-1',
      stale: false,
    })
  })

  it('attaches prNumber when a matching PR is found', () => {
    const ctx: ChainBuildContext = {
      ghIssueByNumber: new Map([[27, { number: 27, title: 't', state: 'open' as const }]]),
      pulls: [{ number: 99, head: { ref: 'feature/27-x' } }],
    }
    const row = buildChainRowFromContext(
      27,
      [
        {
          id: 's1',
          kataMode: 'implementation',
          status: 'idle',
          lastActivity: '2026-04-20T00:00:00Z',
          createdAt: '2026-04-20T00:00:00Z',
          project: 'p',
        },
      ],
      null,
      ctx,
    )
    expect(row!.prNumber).toBe(99)
  })
})
