/**
 * GH#116 P4a — unit tests for `deriveColumn(sessions, arcStatus)`.
 *
 * Split off from `lib/chains.test.ts` (which covered the chain-era
 * version of the same algorithm). Mirrors the 6 fixture cases listed
 * in the spec frontmatter (`phases.p4a.tasks`):
 *
 *   (a) empty sessions → 'backlog' regardless of arcStatus
 *   (b) arcStatus === 'draft' → 'backlog' regardless of sessions
 *   (c) latest session mode='research' → 'research'
 *   (d) latest session mode='implementation' (qualifying) and prior
 *       session mode='debug' (non-qualifying) → 'implementation'
 *       (debug skipped, latest qualifying picked)
 *   (e) all sessions terminal with mode='close' → 'done' (close
 *       special-case)
 *   (f) mixed canonical and non-canonical modes pick the latest
 *       qualifying one
 *
 * Plus a guard test asserting the public `COLUMN_QUALIFYING_MODES`
 * shape — non-qualifying modes (`debug`, `freeform`, `task`, etc.) are
 * deliberately excluded.
 */
import { describe, expect, it } from 'vitest'
import { COLUMN_QUALIFYING_MODES, deriveColumn, isLiveSession, LIVE_STATUSES } from './arcs'

describe('deriveColumn', () => {
  it('returns "backlog" for empty sessions regardless of arcStatus', () => {
    // (a) — empty sessions short-circuits to backlog for every non-draft
    // status. Draft is also backlog (covered by the next test) but
    // that path runs before the empty-check, so we assert both here
    // for completeness.
    expect(deriveColumn([], 'open')).toBe('backlog')
    expect(deriveColumn([], 'closed')).toBe('backlog')
    expect(deriveColumn([], 'archived')).toBe('backlog')
    expect(deriveColumn([], 'draft')).toBe('backlog')
  })

  it('returns "backlog" when arc.status === "draft" even if sessions qualify', () => {
    // (b) — drafts never appear on the kanban board no matter what
    // qualifying sessions they contain.
    expect(
      deriveColumn(
        [
          {
            mode: 'research',
            status: 'idle',
            lastActivity: '2026-04-29T10:00:00Z',
            createdAt: '2026-04-29T09:00:00Z',
          },
          {
            mode: 'implementation',
            status: 'running',
            lastActivity: '2026-04-29T11:00:00Z',
            createdAt: '2026-04-29T10:30:00Z',
          },
        ],
        'draft',
      ),
    ).toBe('backlog')
  })

  it('returns "research" for a single research session', () => {
    // (c) — simplest single-session case.
    expect(
      deriveColumn(
        [
          {
            mode: 'research',
            status: 'idle',
            lastActivity: '2026-04-29T10:00:00Z',
            createdAt: '2026-04-29T09:00:00Z',
          },
        ],
        'open',
      ),
    ).toBe('research')
  })

  it('skips non-qualifying "debug" mode and picks latest qualifying "implementation"', () => {
    // (d) — `debug` is intentionally NOT in COLUMN_QUALIFYING_MODES,
    // so even when it's the chronologically-latest session it must be
    // skipped. The frontier is the latest *qualifying* session.
    expect(
      deriveColumn(
        [
          {
            mode: 'implementation',
            status: 'idle',
            lastActivity: '2026-04-29T10:00:00Z',
            createdAt: '2026-04-29T09:00:00Z',
          },
          {
            mode: 'debug',
            status: 'idle',
            lastActivity: '2026-04-29T11:00:00Z',
            createdAt: '2026-04-29T10:30:00Z',
          },
        ],
        'open',
      ),
    ).toBe('implementation')
  })

  it('returns "done" when latest qualifying session is mode="close" (close special-case)', () => {
    // (e) — `close` qualifies (it IS in COLUMN_QUALIFYING_MODES) and
    // special-cases to the 'done' column. arcStatus stays 'open' here
    // — closure as a column is driven by session mode, not arc status,
    // per the deriveColumn doc comment.
    expect(
      deriveColumn(
        [
          {
            mode: 'close',
            status: 'idle',
            lastActivity: '2026-04-29T11:00:00Z',
            createdAt: '2026-04-29T10:00:00Z',
          },
        ],
        'open',
      ),
    ).toBe('done')
  })

  it('prefers a live qualifying session over a more-recently-touched terminal one', () => {
    // Cleanup of "deriveColumn ignores liveness": when `verify` spawns
    // moments after `implementation` parks-as-idle, the impl row's
    // `lastActivity` is newer than verify's `createdAt`. The pre-cleanup
    // algorithm picked impl by timestamp; the cleanup picks verify by
    // liveness, even though it's chronologically older.
    expect(
      deriveColumn(
        [
          {
            mode: 'implementation',
            status: 'idle',
            lastActivity: '2026-04-29T10:00:05Z', // just parked
            createdAt: '2026-04-29T09:00:00Z',
          },
          {
            mode: 'verify',
            status: 'running',
            lastActivity: null,
            createdAt: '2026-04-29T10:00:00Z', // spawned BEFORE impl parked
          },
        ],
        'open',
      ),
    ).toBe('verify')
  })

  it('falls back to time-keyed pick when no qualifying session is live', () => {
    // No live sessions → the original lastActivity-keyed picker drives
    // the column. Prevents a regression where we accidentally always
    // require a live session.
    expect(
      deriveColumn(
        [
          {
            mode: 'research',
            status: 'idle',
            lastActivity: '2026-04-29T10:00:00Z',
            createdAt: '2026-04-29T09:00:00Z',
          },
          {
            mode: 'planning',
            status: 'idle',
            lastActivity: '2026-04-29T11:00:00Z',
            createdAt: '2026-04-29T10:30:00Z',
          },
        ],
        'open',
      ),
    ).toBe('planning')
  })

  it('among multiple live qualifying sessions, picks the most-recently-spawned', () => {
    // Multiple live rows is rare (the partial-unique index keeps
    // arc/mode pairs from racing) but possible across modes. Spec is:
    // most-recently-spawned wins. createdAt drives the tiebreak (not
    // lastActivity, which may be null on a brand-new running row).
    expect(
      deriveColumn(
        [
          {
            mode: 'planning',
            status: 'pending',
            lastActivity: null,
            createdAt: '2026-04-29T10:00:00Z',
          },
          {
            mode: 'verify',
            status: 'running',
            lastActivity: null,
            createdAt: '2026-04-29T10:30:00Z',
          },
        ],
        'open',
      ),
    ).toBe('verify')
  })

  it('skips non-qualifying live sessions even if they are the most recent (debug)', () => {
    // A live `debug` session must NOT pull the arc out of `backlog` —
    // debug isn't a frontier mode regardless of liveness.
    expect(
      deriveColumn(
        [
          {
            mode: 'debug',
            status: 'running',
            lastActivity: null,
            createdAt: '2026-04-29T11:00:00Z',
          },
        ],
        'open',
      ),
    ).toBe('backlog')
  })

  it('picks the latest qualifying session when canonical and non-canonical modes are mixed', () => {
    // (f) — `freeform` is non-qualifying and is the chronologically
    // latest, so the algorithm falls back to the prior `planning`
    // session even though it's older.
    expect(
      deriveColumn(
        [
          {
            mode: 'planning',
            status: 'idle',
            lastActivity: '2026-04-29T10:00:00Z',
            createdAt: '2026-04-29T09:30:00Z',
          },
          {
            mode: 'freeform',
            status: 'idle',
            lastActivity: '2026-04-29T12:00:00Z',
            createdAt: '2026-04-29T11:30:00Z',
          },
        ],
        'open',
      ),
    ).toBe('planning')
  })
})

describe('COLUMN_QUALIFYING_MODES', () => {
  it('contains exactly the 5 expected canonical modes', () => {
    // Guard against drift: `task` (legacy implementation alias) and
    // `debug` / `freeform` (non-qualifying) must NOT be in this set.
    expect(COLUMN_QUALIFYING_MODES).toEqual(
      new Set(['research', 'planning', 'implementation', 'verify', 'close']),
    )
  })

  it('does not contain the dropped legacy or non-qualifying modes', () => {
    expect(COLUMN_QUALIFYING_MODES.has('task')).toBe(false)
    expect(COLUMN_QUALIFYING_MODES.has('debug')).toBe(false)
    expect(COLUMN_QUALIFYING_MODES.has('freeform')).toBe(false)
  })
})

describe('LIVE_STATUSES / isLiveSession', () => {
  it('contains the runtime "doing work" statuses', () => {
    // Mirrors SessionStatus in packages/shared-types minus terminal
    // states (`idle`, `error`). `idle` is intentionally excluded —
    // it's ambiguous (freshly-spawned vs parked-terminal) and is
    // disambiguated by `isArcSessionCompleted` instead.
    expect(LIVE_STATUSES).toEqual(
      new Set([
        'running',
        'pending',
        'waiting_input',
        'waiting_permission',
        'waiting_gate',
        'waiting_identity',
        'failover',
      ]),
    )
  })

  it('does not include idle or error', () => {
    expect(LIVE_STATUSES.has('idle')).toBe(false)
    expect(LIVE_STATUSES.has('error')).toBe(false)
  })

  it('isLiveSession matches the LIVE_STATUSES set', () => {
    expect(isLiveSession({ status: 'running' })).toBe(true)
    expect(isLiveSession({ status: 'waiting_input' })).toBe(true)
    expect(isLiveSession({ status: 'idle' })).toBe(false)
    expect(isLiveSession({ status: 'error' })).toBe(false)
  })
})
