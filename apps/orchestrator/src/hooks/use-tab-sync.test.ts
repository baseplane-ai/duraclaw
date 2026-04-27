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
 *   - `project:P` → membership: `project === P`
 *   - null        → no cluster, append at max+1
 */

import { describe, expect, it } from 'vitest'
import type { TabMeta } from '~/lib/types'
import { collectReplaceTabDedupIds, computeFollowMap, computeInsertOrder } from './use-tab-sync'

type Entry = {
  order: number
  project?: string
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

// ─── current-session follow map (cross-device) ──────────────────────
//
// Peer devices broadcast tab-row deltas via the synced collection; the
// hook diffs them across renders so the local view follows whichever
// session ends up inside the tab the user is on.

describe('computeFollowMap', () => {
  it('pairs same-row sessionId swaps (replaceTab PATCH path)', () => {
    // A peer (or this device's own draft → real swap) updates the row's
    // sessionId in place. Same row id, new sessionId.
    const prev = [{ id: 'r1', sessionId: 'draft:abc', project: 'proj-a' }]
    const curr = [{ id: 'r1', sessionId: 'sess-real', project: 'proj-a' }]
    const map = computeFollowMap(prev, curr)
    expect(map.get('draft:abc')).toBe('sess-real')
  })

  it('pairs delete+insert by project (openTab one-tab-per-project path)', () => {
    // Peer started a new session in proj-a — its `openTab` deleted the
    // existing proj-a row and inserted a fresh one with a different id.
    const prev = [{ id: 'r1', sessionId: 'sess-old', project: 'proj-a' }]
    const curr = [{ id: 'r2', sessionId: 'sess-new', project: 'proj-a' }]
    const map = computeFollowMap(prev, curr)
    expect(map.get('sess-old')).toBe('sess-new')
  })

  it('does not pair across different projects', () => {
    // Tab for proj-a deleted, separate tab for proj-b inserted — these
    // are unrelated and must not be merged.
    const prev = [{ id: 'r1', sessionId: 'sess-old', project: 'proj-a' }]
    const curr = [{ id: 'r2', sessionId: 'sess-new', project: 'proj-b' }]
    const map = computeFollowMap(prev, curr)
    expect(map.size).toBe(0)
  })

  it('skips delete+insert pairing when the project is ambiguous', () => {
    // Two tabs deleted for proj-a, one inserted: the pairing is
    // ambiguous — we'd rather no-op than guess. Same goes for the
    // mirror (one deleted, two inserted).
    const prev = [
      { id: 'r1', sessionId: 'sess-1', project: 'proj-a' },
      { id: 'r2', sessionId: 'sess-2', project: 'proj-a' },
    ]
    const curr = [{ id: 'r3', sessionId: 'sess-3', project: 'proj-a' }]
    const map = computeFollowMap(prev, curr)
    expect(map.size).toBe(0)
  })

  it('emits no entries when rows are unchanged', () => {
    const prev = [{ id: 'r1', sessionId: 'sess-1', project: 'proj-a' }]
    const curr = [{ id: 'r1', sessionId: 'sess-1', project: 'proj-a' }]
    expect(computeFollowMap(prev, curr).size).toBe(0)
  })

  it('does not pair project-less rows by anything other than row id', () => {
    // A row with no project that vanishes and a different row with no
    // project that appears must NOT be paired — the project-fallback
    // rule would otherwise merge unrelated ad-hoc tabs.
    const prev = [{ id: 'r1', sessionId: 'sess-old' }]
    const curr = [{ id: 'r2', sessionId: 'sess-new' }]
    expect(computeFollowMap(prev, curr).size).toBe(0)
  })

  it('prefers row-id swap over project pairing when both could match', () => {
    // r1 swapped sessionId in-place AND a separate proj-a row turnover
    // happened. The row-id swap is unambiguous; the project pairing
    // for r1 must not overwrite it.
    const prev = [
      { id: 'r1', sessionId: 'draft:x', project: 'proj-a' },
      { id: 'r2', sessionId: 'sess-old', project: 'proj-b' },
    ]
    const curr = [
      { id: 'r1', sessionId: 'sess-real', project: 'proj-a' },
      { id: 'r3', sessionId: 'sess-new', project: 'proj-b' },
    ]
    const map = computeFollowMap(prev, curr)
    expect(map.get('draft:x')).toBe('sess-real')
    expect(map.get('sess-old')).toBe('sess-new')
  })
})
