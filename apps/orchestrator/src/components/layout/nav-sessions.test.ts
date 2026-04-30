/**
 * Unit test for `isImplicitSingleSessionArc` (GH#116 P4b).
 *
 * The implicit-arc filter governs whether the sidebar Arcs section
 * collapses an arc into a single flat session row (no expand chevron,
 * no group label) or renders it as a multi-session ArcGroup. The four
 * boundary cases below come straight from the spec frontmatter
 * (`phases.p4b.tasks` bullet 3 / `test_cases.implicit-single-session-arc-filter`).
 */

import { describe, expect, it } from 'vitest'
import type { ArcSummary } from '~/lib/types'
import { isImplicitSingleSessionArc } from './nav-sessions'

function mkSession(id: string, mode: string | null = 'task'): ArcSummary['sessions'][number] {
  return {
    id,
    mode,
    status: 'idle',
    lastActivity: '2026-04-29T10:00:00Z',
    createdAt: '2026-04-29T09:00:00Z',
  }
}

function mkArc(overrides: Partial<ArcSummary> = {}): ArcSummary {
  return {
    id: 'arc_test',
    title: 'Test arc',
    externalRef: null,
    status: 'open',
    createdAt: '2026-04-29T08:00:00Z',
    updatedAt: '2026-04-29T08:00:00Z',
    sessions: [mkSession('sess_a')],
    lastActivity: '2026-04-29T10:00:00Z',
    ...overrides,
  }
}

describe('isImplicitSingleSessionArc', () => {
  it('(a) returns true when externalRef is null + 1 session + no parent', () => {
    const arc = mkArc({
      externalRef: null,
      sessions: [mkSession('sess_only')],
      // parentArcId omitted (undefined) — `==` null still matches
    })
    expect(isImplicitSingleSessionArc(arc)).toBe(true)
  })

  it('(b) returns false when externalRef is set (multi-session capable)', () => {
    const arc = mkArc({
      externalRef: { provider: 'github', id: 116, url: 'https://github.com/x/y/issues/116' },
      sessions: [mkSession('sess_only')],
    })
    expect(isImplicitSingleSessionArc(arc)).toBe(false)
  })

  it('(c) returns false when externalRef is null but the arc has 2 sessions', () => {
    const arc = mkArc({
      externalRef: null,
      sessions: [mkSession('sess_a'), mkSession('sess_b')],
    })
    expect(isImplicitSingleSessionArc(arc)).toBe(false)
  })

  it('(d) returns false when parentArcId is set (this is a side arc)', () => {
    const arc = mkArc({
      externalRef: null,
      sessions: [mkSession('sess_only')],
      parentArcId: 'arc_parent',
    })
    expect(isImplicitSingleSessionArc(arc)).toBe(false)
  })
})
