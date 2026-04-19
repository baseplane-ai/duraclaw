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
 * stay put inside their project cluster.
 */

import { describe, expect, it } from 'vitest'
import { computeInsertOrder } from './use-tab-sync'

type Entry = { order: number; project?: string }

describe('computeInsertOrder', () => {
  it('reuses the vacated order on the replace path (one-tab-per-project)', () => {
    // A/B/C live at 1/2/3. We just replaced the project-B tab, so its
    // order (2) is the `reusedOrder`, and the remaining list no longer
    // contains project B.
    const remaining: Entry[] = [
      { order: 1, project: 'a' },
      { order: 3, project: 'c' },
    ]
    expect(computeInsertOrder(remaining, 'b', 2)).toBe(2)
  })

  it('appends at the end when the project has no existing tabs', () => {
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, project: 'b' },
    ]
    expect(computeInsertOrder(entries, 'brand-new', null)).toBe(3)
  })

  it('appends at the end when no project is supplied', () => {
    const entries: Entry[] = [{ order: 5 }, { order: 7 }]
    expect(computeInsertOrder(entries, undefined, null)).toBe(8)
  })

  it('starts at order 1 when the tab list is empty', () => {
    expect(computeInsertOrder([], 'any', null)).toBe(1)
    expect(computeInsertOrder([], undefined, null)).toBe(1)
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
    expect(computeInsertOrder(entries, 'b', null)).toBe(2.5)
  })

  it('appends after a project cluster that is already at the tail', () => {
    // Project B has the highest order — no "next" tab to wedge against,
    // so just extend the cluster with order + 1.
    const entries: Entry[] = [
      { order: 1, project: 'a' },
      { order: 2, project: 'b' },
    ]
    expect(computeInsertOrder(entries, 'b', null)).toBe(3)
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
    expect(computeInsertOrder(entries, 'b', null)).toBe(2.75)
  })
})
