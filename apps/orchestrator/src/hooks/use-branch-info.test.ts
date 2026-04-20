/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────

let mockLiveQueryData: Array<Record<string, unknown>> | undefined = []

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({
    get data() {
      return mockLiveQueryData
    },
  }),
}))

const mockCreateBranchInfoCollection = vi.hoisted(() => vi.fn())

vi.mock('~/db/branch-info-collection', () => {
  const coll = { [Symbol.iterator]: vi.fn().mockReturnValue([][Symbol.iterator]()) }
  mockCreateBranchInfoCollection.mockImplementation(() => coll)
  return {
    createBranchInfoCollection: mockCreateBranchInfoCollection,
  }
})

import { useBranchInfo } from './use-branch-info'

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    parentMsgId: 'msg-0',
    sessionId: 'session-abc',
    siblings: ['usr-1', 'usr-3'],
    activeId: 'usr-1',
    updatedAt: '2026-04-19T00:00:00Z',
    ...overrides,
  }
}

describe('useBranchInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLiveQueryData = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when collection has no rows', () => {
    mockLiveQueryData = []
    const { result } = renderHook(() => useBranchInfo('session-abc', 'msg-0'))
    expect(result.current).toBeNull()
  })

  it('returns null when no row matches parentMsgId', () => {
    mockLiveQueryData = [makeRow({ parentMsgId: 'other-parent' })]
    const { result } = renderHook(() => useBranchInfo('session-abc', 'msg-0'))
    expect(result.current).toBeNull()
  })

  it('returns the matching row as {current, total, siblings, activeId}', () => {
    mockLiveQueryData = [
      makeRow({
        parentMsgId: 'msg-0',
        siblings: ['usr-1', 'usr-3', 'usr-5'],
        activeId: 'usr-3',
      }),
    ]
    const { result } = renderHook(() => useBranchInfo('session-abc', 'msg-0'))
    expect(result.current).toEqual({
      current: 2,
      total: 3,
      siblings: ['usr-1', 'usr-3', 'usr-5'],
      activeId: 'usr-3',
    })
  })

  it('returns current=1 when activeId is the first sibling', () => {
    mockLiveQueryData = [makeRow({ siblings: ['usr-1', 'usr-3'], activeId: 'usr-1' })]
    const { result } = renderHook(() => useBranchInfo('session-abc', 'msg-0'))
    expect(result.current?.current).toBe(1)
  })

  it('returns current=total when activeId is the last sibling', () => {
    mockLiveQueryData = [makeRow({ siblings: ['usr-1', 'usr-3', 'usr-5'], activeId: 'usr-5' })]
    const { result } = renderHook(() => useBranchInfo('session-abc', 'msg-0'))
    expect(result.current?.current).toBe(3)
    expect(result.current?.total).toBe(3)
  })

  it('falls back to current=1 when activeId is not in siblings array', () => {
    mockLiveQueryData = [makeRow({ siblings: ['usr-1', 'usr-3'], activeId: 'usr-ghost' })]
    const { result } = renderHook(() => useBranchInfo('session-abc', 'msg-0'))
    expect(result.current?.current).toBe(1)
  })

  it('re-memoises the collection when agentName changes', () => {
    mockLiveQueryData = []
    const { rerender } = renderHook(
      ({ agent }: { agent: string }) => useBranchInfo(agent, 'msg-0'),
      { initialProps: { agent: 'agent-a' } },
    )

    expect(mockCreateBranchInfoCollection).toHaveBeenCalledWith('agent-a')

    rerender({ agent: 'agent-b' })
    expect(mockCreateBranchInfoCollection).toHaveBeenCalledWith('agent-b')
  })
})
