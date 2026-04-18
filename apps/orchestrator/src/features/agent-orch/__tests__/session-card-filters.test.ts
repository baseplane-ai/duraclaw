/**
 * Integration tests for session card filtering logic.
 *
 * Tests the combined behavior of status filtering, workspace filtering,
 * date range splitting, and archived session exclusion as used by
 * SessionCardList and SessionSidebar.
 */

import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '~/db/sessions-collection'
import { isQualifyingSession } from '../ActiveStrip'
import { getRecentAndOlder, isInDateRange } from '../FilterChipBar'
import { getDateGroup } from '../SessionSidebar'

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    userId: 'user-1',
    project: 'test-project',
    status: 'idle',
    model: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    ...overrides,
  }
}

describe('combined session filtering', () => {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const twoWeeksAgo = new Date(now)
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

  const sessions: SessionRecord[] = [
    makeSession({
      id: 'running-today',
      status: 'running',
      project: 'proj-a',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }),
    makeSession({
      id: 'idle-yesterday',
      status: 'idle',
      project: 'proj-a',
      createdAt: yesterday.toISOString(),
      updatedAt: yesterday.toISOString(),
    }),
    makeSession({
      id: 'failed-old',
      status: 'failed',
      project: 'proj-b',
      createdAt: twoWeeksAgo.toISOString(),
      updatedAt: twoWeeksAgo.toISOString(),
    }),
    makeSession({
      id: 'archived-today',
      status: 'idle',
      project: 'proj-a',
      createdAt: now.toISOString(),
      archived: true,
    }),
  ]

  it('filters by status: only running sessions pass "running" filter', () => {
    const running = sessions.filter((s) => s.status === 'running')
    expect(running).toHaveLength(1)
    expect(running[0].id).toBe('running-today')
  })

  it('filters by workspace: only proj-a sessions when workspace is ["proj-a"]', () => {
    const workspaceProjects = ['proj-a']
    const filtered = sessions.filter((s) => workspaceProjects.includes(s.project))
    expect(filtered).toHaveLength(3)
    expect(filtered.every((s) => s.project === 'proj-a')).toBe(true)
  })

  it('excludes archived sessions', () => {
    const visible = sessions.filter((s) => !s.archived)
    expect(visible).toHaveLength(3)
    expect(visible.find((s) => s.id === 'archived-today')).toBeUndefined()
  })

  it('splits recent and older by this-week range', () => {
    const visible = sessions.filter((s) => !s.archived)
    const { recent, older } = getRecentAndOlder(visible, 'this-week')
    expect(recent).toHaveLength(2) // today + yesterday
    expect(older).toHaveLength(1) // two weeks ago
    expect(older[0].id).toBe('failed-old')
  })

  it('puts all sessions in recent when range is "all"', () => {
    const visible = sessions.filter((s) => !s.archived)
    const { recent, older } = getRecentAndOlder(visible, 'all')
    expect(recent).toHaveLength(3)
    expect(older).toHaveLength(0)
  })

  it('combined: workspace + status + date range filters work together', () => {
    const workspaceProjects = ['proj-a']
    const statusFilter = 'all'
    const filtered = sessions.filter((s) => {
      if (!workspaceProjects.includes(s.project)) return false
      if (s.archived) return false
      if (statusFilter === 'running') return s.status === 'running'
      return true
    })
    const { recent, older } = getRecentAndOlder(filtered, 'today')
    expect(recent).toHaveLength(1) // only running-today
    expect(older).toHaveLength(1) // idle-yesterday
  })
})

describe('date grouping consistency', () => {
  it('getDateGroup and isInDateRange agree on "today"', () => {
    const todayStr = new Date().toISOString()
    expect(getDateGroup(todayStr)).toBe('Today')
    expect(isInDateRange(todayStr, 'today')).toBe(true)
  })

  it('getDateGroup labels yesterday correctly', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(12, 0, 0, 0)
    expect(getDateGroup(yesterday.toISOString())).toBe('Yesterday')
  })
})

describe('active strip + filter interaction', () => {
  it('active strip qualifies running sessions regardless of recency', () => {
    const oldRunning = makeSession({
      status: 'running',
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    })
    // Running always qualifies for strip
    expect(isQualifyingSession(oldRunning)).toBe(true)
    // But by creation date, it falls outside "this-week"
    const { older } = getRecentAndOlder([oldRunning], 'this-week')
    expect(older).toHaveLength(1)
  })

  it('idle session within 2h qualifies for strip but may be in older by creation date', () => {
    const recentIdleOldCreation = makeSession({
      status: 'idle',
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    })
    expect(isQualifyingSession(recentIdleOldCreation)).toBe(true)
    // But by creation date, it's old
    const { older } = getRecentAndOlder([recentIdleOldCreation], 'this-week')
    expect(older).toHaveLength(1)
  })
})
