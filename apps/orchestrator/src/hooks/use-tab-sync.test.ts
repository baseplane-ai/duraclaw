/**
 * @vitest-environment node
 *
 * Pure-logic tests for the tab-insertion ordering rule. The full hook
 * needs a Yjs doc + React renderer to exercise; this test covers the
 * exported `computeInsertOrder` helper that backs `openTab`.
 *
 * Bug context: when a user opened a new session for a project that
 * already had a tab, the old tab was deleted (one-tab-per-project) and
 * the new tab was assigned `max(order) + 1`, so it jumped to the far
 * right of the bar regardless of its original position. New tabs should
 * stay put inside their cluster.
 *
 * Cluster keys:
 *   - `project:P` → membership: `kind !== 'chain' && project === P`
 *   - `issue:N`   → membership: `kind === 'chain' && issueNumber === N`
 *   - null        → no cluster, append at max+1
 */

import { describe, expect, it } from 'vitest'
import type { TabMeta } from '~/lib/types'
import { collectReplaceTabDedupIds, computeInsertOrder } from './use-tab-sync'

type Entry = {
  order: number
  project?: string
  kind?: 'chain' | 'session'
  issueNumber?: number
}

describe('computeInsertOrder', () => {
  it('reuses the vacated order on the replace path (one-tab-per-project)', () => {
    // A/B/C live at 1/2/3. We just replaced the project-B tab, so its
    // order (2) is the `reusedOrder`, and the remaining list no longer
    // contains project B.
    const remaining: Entry[] = [
      { order: 1, project: 'a' },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(remaining, 'project:b', 2)).toBe(2)
  })

  it('appends at the end when the project has no existing tabs', () => {
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, project: 'b' },
    ]
    expect(computeInsertOrder(entries, 'project:brand-new', null)).toBe(3)
  })

  it('appends at the end when clusterKey is null', () => {
    const entries: Entry[] = [{ order: 5 }, { order: 7 }]
    expect(computeInsertOrder(entries, null, null)).toBe(8)
  })

  it('starts at order 1 when the tab list is empty', () => {
    expect(computeInsertOrder([], 'project:any', null)).toBe(1)
    expect(computeInsertOrder([], null, null)).toBe(1)
  })

  it('inserts adjacent to the project cluster when force-new-tab + project exists', () => {
    // Force a new B tab alongside the existing one. Existing order for
    // B is 2; the next tab after B is C at order 3, so the new tab
    // should land between them (2.5) — inside the project cluster.
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, project: 'b' },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(entries, 'project:b', null)).toBe(2.5)
  })

  it('appends after a project cluster that is already at the tail', () => {
    // Project B has the highest order — no "next" tab to wedge against,
    // so just extend the cluster with order + 1.
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, project: 'b' },
    ]
    expect(computeInsertOrder(entries, 'project:b', null)).toBe(3)
  })

  it('uses the last same-project order when a cluster spans multiple tabs', () => {
    // Project B already has two tabs (2 and 2.5 from a previous insert).
    // The new B tab should slot between 2.5 and the next non-B tab (3).
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, project: 'b' },
      { order: 2.5, project: 'b' },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(entries, 'project:b', null)).toBe(2.75)
  })

  // ── Chain cluster tests ──────────────────────────────────────────────

  it('chain tab appends at end when no chain tab exists for that issue', () => {
    // Project "b" exists but it's a session cluster — issue:42 has no
    // members, so a new chain tab for #42 appends at max+1.
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, project: 'b' },
    ]
    expect(computeInsertOrder(entries, 'issue:42', null)).toBe(3)
  })

  it('chain tabs form their own cluster independent of same-named projects', () => {
    // A chain tab for issue 42 exists at order 2. Its project field is
    // irrelevant — membership is by `kind === 'chain' && issueNumber`.
    // A new chain tab for #42 should slot between 2 and 3.
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, kind: 'chain', issueNumber: 42 },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(entries, 'issue:42', null)).toBe(2.5)
  })

  it('two chain tabs for different issues form separate clusters', () => {
    // Chain #42 at order 2. A new chain tab for #43 doesn't share its
    // cluster, so #43 appends at max+1.
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, kind: 'chain', issueNumber: 42 },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(entries, 'issue:43', null)).toBe(4)
  })

  it('project cluster excludes chain tabs even when they share a project field', () => {
    // A chain tab happens to carry project: 'b' (defensive — should
    // never happen in practice, but membership must still exclude it).
    // The only session-kind 'b' tab is at order 1, next non-b is c at 3
    // (the chain tab at 2 is not part of the project cluster and not a
    // next non-cluster tab either). New project-b tab should land
    // between 1 and 2 (the chain tab is the next non-project-b entry).
    const entries: Entry[] = [
      { order: 1, project: 'b' },
      { order: 2, kind: 'chain', issueNumber: 42, project: 'b' },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(entries, 'project:b', null)).toBe(1.5)
  })

  it('chain cluster uses fractional order between cluster-last and next non-cluster tab', () => {
    // Two chain tabs for #42 at orders 2 and 2.5, then project-c at 3.
    // New chain tab #42 should slot between 2.5 and 3 → 2.75.
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, kind: 'chain', issueNumber: 42 },
      { order: 2.5, kind: 'chain', issueNumber: 42 },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(entries, 'issue:42', null)).toBe(2.75)
  })

  it('null clusterKey always appends at max+1 regardless of entry shape', () => {
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, kind: 'chain', issueNumber: 42 },
    ]
    expect(computeInsertOrder(entries, null, null)).toBe(3)
  })
})

// ─── replaceTab dedup candidate selection ───────────────────────────
//
// Regression coverage for the project-tab-accumulation bug: when the
// user submits a new session from an active draft tab and there's
// already a tab for the same project, `replaceTab` must collapse the
// existing project tab instead of leaving two tabs for the same
// project. Core identification logic is pure — the caller deletes the
// returned ids from the collection.

type Row = {
  id: string
  sessionId: string | null
  meta: TabMeta
}

describe('collectReplaceTabDedupIds', () => {
  it('deletes peer project tabs but not the draft being replaced', () => {
    // Existing tab for proj-a (row "r1") + active draft (row "r2").
    // Submitting the draft as a new proj-a session should flag r1 for
    // deletion; r2 stays (it will be swapped to the new sessionId).
    const rows: Row[] = [
      { id: 'r1', sessionId: 'sess-1', meta: { project: 'proj-a' } },
      { id: 'r2', sessionId: 'draft:xyz', meta: {} },
    ]
    expect(collectReplaceTabDedupIds(rows, 'draft:xyz', 'sess-2', 'proj-a')).toEqual(['r1'])
  })

  it('does not touch chain tabs even if they carry a matching project', () => {
    const rows: Row[] = [
      { id: 'r1', sessionId: 'sess-1', meta: { project: 'proj-a' } },
      {
        id: 'r2',
        sessionId: 'chain:42',
        meta: { kind: 'chain', issueNumber: 42, project: 'proj-a' },
      },
      { id: 'r3', sessionId: 'draft:xyz', meta: {} },
    ]
    expect(collectReplaceTabDedupIds(rows, 'draft:xyz', 'sess-2', 'proj-a')).toEqual(['r1'])
  })

  it('does not touch tabs for other projects', () => {
    const rows: Row[] = [
      { id: 'r1', sessionId: 'sess-1', meta: { project: 'proj-a' } },
      { id: 'r2', sessionId: 'sess-other', meta: { project: 'proj-b' } },
      { id: 'r3', sessionId: 'draft:xyz', meta: {} },
    ]
    expect(collectReplaceTabDedupIds(rows, 'draft:xyz', 'sess-2', 'proj-a')).toEqual(['r1'])
  })

  it('skips the target newId even when its row carries the same project', () => {
    // Racy case: if the new sessionId already has a row (dupe path),
    // we must not delete it — the dupe path activates it.
    const rows: Row[] = [
      { id: 'r1', sessionId: 'sess-2', meta: { project: 'proj-a' } },
      { id: 'r2', sessionId: 'draft:xyz', meta: {} },
    ]
    expect(collectReplaceTabDedupIds(rows, 'draft:xyz', 'sess-2', 'proj-a')).toEqual([])
  })

  it('returns empty when no peer tabs match', () => {
    const rows: Row[] = [
      { id: 'r1', sessionId: 'sess-other', meta: { project: 'proj-b' } },
      { id: 'r2', sessionId: 'draft:xyz', meta: {} },
    ]
    expect(collectReplaceTabDedupIds(rows, 'draft:xyz', 'sess-2', 'proj-a')).toEqual([])
  })

  it('flags every peer tab when the project has accumulated more than one', () => {
    // Regression safety net: if the leak already happened, the next
    // submit should collapse all of them, not just one.
    const rows: Row[] = [
      { id: 'r1', sessionId: 'sess-1', meta: { project: 'proj-a' } },
      { id: 'r2', sessionId: 'sess-1b', meta: { project: 'proj-a' } },
      { id: 'r3', sessionId: 'draft:xyz', meta: {} },
    ]
    expect(collectReplaceTabDedupIds(rows, 'draft:xyz', 'sess-2', 'proj-a')).toEqual(['r1', 'r2'])
  })
})
