/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChainSummary } from '~/lib/types'
import { advanceChain, chainProject } from './advance-chain'

function chain(overrides: Partial<ChainSummary> = {}): ChainSummary {
  return {
    issueNumber: 82,
    issueTitle: 'test chain',
    issueType: 'bug',
    issueState: 'open',
    column: 'backlog',
    sessions: [],
    worktreeReservation: null,
    lastActivity: '2026-04-24T00:00:00Z',
    ...overrides,
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('chainProject', () => {
  it('returns null for an empty chain (backlog-bootstrap needs a picker)', () => {
    expect(chainProject(chain())).toBeNull()
  })

  it('returns the most-recent session project when sessions exist', () => {
    const c = chain({
      sessions: [
        {
          id: 's-old',
          kataMode: 'research',
          status: 'idle',
          lastActivity: '2026-04-20T00:00:00Z',
          createdAt: '2026-04-20T00:00:00Z',
          project: 'duraclaw-dev1',
        },
        {
          id: 's-new',
          kataMode: 'planning',
          status: 'idle',
          lastActivity: '2026-04-24T00:00:00Z',
          createdAt: '2026-04-24T00:00:00Z',
          project: 'duraclaw-dev4',
        },
      ],
    })
    expect(chainProject(c)).toBe('duraclaw-dev4')
  })
})

describe('advanceChain', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // GH#82 scenario-1 regression. Pre-fix, advanceChain() on an empty chain
  // always returned `{ ok: false, error: 'No project for chain' }`, which
  // blocked the backlog "Start research" flow entirely. The modal now
  // resolves a worktree via the picker and passes it through.
  it('uses projectOverride when the chain has no sessions', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { session_id: 'new-session-id' }))

    const res = await advanceChain(chain({ column: 'backlog' }), 'research', {
      projectOverride: 'duraclaw-dev4',
    })

    expect(res).toEqual({ ok: true, sessionId: 'new-session-id' })
    // Spawn call carries the override as project.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    const spawnBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(spawnBody.project).toBe('duraclaw-dev4')
    expect(spawnBody.kataIssue).toBe(82)
    expect(spawnBody.agent).toBe('research')
  })

  it('returns error when backlog chain has neither sessions nor projectOverride', async () => {
    const res = await advanceChain(chain({ column: 'backlog' }), 'research')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('No project')
  })

  it('falls back to chainProject when projectOverride is null/undefined', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { session_id: 'next-session' }),
    )
    const c = chain({
      column: 'research',
      sessions: [
        {
          id: 'prev',
          kataMode: 'research',
          status: 'idle', // ACTIVE_STATUSES includes 'idle' → abort before spawn
          lastActivity: '2026-04-24T00:00:00Z',
          createdAt: '2026-04-24T00:00:00Z',
          project: 'duraclaw-dev1',
        },
      ],
    })
    // KanbanCard passes `projectOverride: null` for chains that already
    // have a session (see runAdvance); verify the fallback path.
    await advanceChain(c, 'planning', { projectOverride: null })
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    const spawnCall = calls.find((call) => call[0] === '/api/sessions')
    expect(spawnCall).toBeDefined()
    const spawnBody = JSON.parse((spawnCall![1] as RequestInit).body as string)
    expect(spawnBody.project).toBe('duraclaw-dev1')
  })
})
