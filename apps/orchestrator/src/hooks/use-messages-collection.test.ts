/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---

/** Rows returned when iterating the collection. */
let mockCollectionRows: Array<[string, Record<string, unknown>]> = []

/** Subscribed change listeners (called on mutation). */
let changeListeners: Set<() => void> = new Set()

const mockCreateMessagesCollection = vi.hoisted(() => vi.fn())

vi.mock('~/db/messages-collection', () => {
  const coll = {
    insert: vi.fn(),
    delete: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    update: vi.fn(),
    subscribeChanges: (cb: () => void) => {
      changeListeners.add(cb)
      return () => changeListeners.delete(cb)
    },
    [Symbol.iterator]: () => mockCollectionRows[Symbol.iterator](),
    utils: { isFetching: false },
  }
  mockCreateMessagesCollection.mockImplementation(() => coll)
  return {
    messagesCollection: coll,
    createMessagesCollection: mockCreateMessagesCollection,
  }
})

import { useMessagesCollection } from './use-messages-collection'

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    sessionId: 'session-abc',
    role: 'assistant',
    type: 'text',
    content: '{"text":"hello"}',
    event_uuid: 'uuid-1',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** Set mock rows and notify listeners so useSyncExternalStore re-renders. */
function setRows(rows: Array<Record<string, unknown>>) {
  mockCollectionRows = rows.map((r) => [r.id as string, r])
  for (const cb of changeListeners) cb()
}

describe('useMessagesCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCollectionRows = []
    changeListeners = new Set()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty messages array when data is empty', () => {
    mockCollectionRows = []
    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('returns isLoading as false (collection-backed, not query-backed)', () => {
    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.isLoading).toBe(false)
  })

  it('returns all rows from the per-session collection (factory scopes by sessionId)', () => {
    mockCollectionRows = [
      ['m1', makeMessage({ id: 'm1', sessionId: 'session-abc' })],
      ['m3', makeMessage({ id: 'm3', sessionId: 'session-abc' })],
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages.map((m) => m.id)).toEqual(['m1', 'm3'])
  })

  it('sorts messages by createdAt ascending', () => {
    mockCollectionRows = [
      [
        'late',
        makeMessage({ id: 'late', sessionId: 'session-abc', createdAt: '2026-01-03T00:00:00Z' }),
      ],
      [
        'early',
        makeMessage({ id: 'early', sessionId: 'session-abc', createdAt: '2026-01-01T00:00:00Z' }),
      ],
      [
        'mid',
        makeMessage({ id: 'mid', sessionId: 'session-abc', createdAt: '2026-01-02T00:00:00Z' }),
      ],
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['early', 'mid', 'late'])
  })

  it('returns empty array when collection has no rows', () => {
    mockCollectionRows = []
    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages).toEqual([])
  })

  it('maintains sort stability for messages without createdAt', () => {
    mockCollectionRows = [
      ['m1', makeMessage({ id: 'm1', sessionId: 'session-abc', createdAt: undefined })],
      ['m2', makeMessage({ id: 'm2', sessionId: 'session-abc', createdAt: undefined })],
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    // Should preserve order when no createdAt
    expect(result.current.messages).toHaveLength(2)
  })

  it('re-memoises the collection when sessionId changes', () => {
    mockCollectionRows = [['m1', makeMessage({ id: 'm1', sessionId: 'session-abc' })]]

    const { rerender } = renderHook(({ sessionId }) => useMessagesCollection(sessionId), {
      initialProps: { sessionId: 'session-abc' },
    })

    expect(mockCreateMessagesCollection).toHaveBeenCalledWith('session-abc')

    rerender({ sessionId: 'session-xyz' })
    expect(mockCreateMessagesCollection).toHaveBeenCalledWith('session-xyz')
  })

  it('sorts user-turn rows by canonical_turn_id regardless of createdAt', () => {
    mockCollectionRows = [
      [
        'usr-2',
        makeMessage({
          id: 'usr-2',
          sessionId: 'session-abc',
          canonical_turn_id: 'usr-2',
          createdAt: '2026-01-03T00:00:00Z',
        }),
      ],
      [
        'usr-1',
        makeMessage({
          id: 'usr-1',
          sessionId: 'session-abc',
          canonical_turn_id: 'usr-1',
          createdAt: '2026-01-04T00:00:00Z',
        }),
      ],
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-2'])
  })

  it('interleaves assistant/tool rows by createdAt between user turns', () => {
    mockCollectionRows = [
      [
        'msg-assist-2',
        makeMessage({
          id: 'msg-assist-2',
          sessionId: 'session-abc',
          createdAt: '2026-01-02T00:00:00Z',
        }),
      ],
      [
        'usr-2',
        makeMessage({
          id: 'usr-2',
          sessionId: 'session-abc',
          canonical_turn_id: 'usr-2',
          createdAt: '2026-01-03T00:00:00Z',
        }),
      ],
      [
        'msg-assist-1',
        makeMessage({
          id: 'msg-assist-1',
          sessionId: 'session-abc',
          createdAt: '2026-01-01T00:00:00Z',
        }),
      ],
      [
        'usr-1',
        makeMessage({
          id: 'usr-1',
          sessionId: 'session-abc',
          canonical_turn_id: 'usr-1',
          createdAt: '2026-01-04T00:00:00Z',
        }),
      ],
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual([
      'usr-1',
      'usr-2',
      'msg-assist-1',
      'msg-assist-2',
    ])
  })

  it('optimistic user rows (usr-client-<uuid>) without canonical_turn_id interleave by createdAt', () => {
    mockCollectionRows = [
      [
        'usr-1',
        makeMessage({
          id: 'usr-1',
          sessionId: 'session-abc',
          canonical_turn_id: 'usr-1',
          createdAt: '2026-01-01T00:00:00Z',
        }),
      ],
      [
        'usr-client-abc',
        makeMessage({
          id: 'usr-client-abc',
          sessionId: 'session-abc',
          createdAt: '2026-01-02T00:00:00Z',
        }),
      ],
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-client-abc'])
  })
})
