/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---

let mockLiveQueryData: Array<Record<string, unknown>> | undefined = []
let mockLiveQueryIsLoading = false

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({
    get data() {
      return mockLiveQueryData
    },
    get isLoading() {
      return mockLiveQueryIsLoading
    },
  }),
}))

const mockCreateMessagesCollection = vi.hoisted(() => vi.fn())

vi.mock('~/db/messages-collection', () => {
  const coll = {
    insert: vi.fn(),
    delete: vi.fn(),
    [Symbol.iterator]: vi.fn().mockReturnValue([][Symbol.iterator]()),
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

describe('useMessagesCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLiveQueryData = []
    mockLiveQueryIsLoading = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty messages array when data is empty', () => {
    mockLiveQueryData = []
    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('returns isLoading from useLiveQuery', () => {
    mockLiveQueryIsLoading = true
    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.isLoading).toBe(true)
  })

  it('returns all rows from the per-session collection (factory scopes by sessionId)', () => {
    mockLiveQueryData = [
      makeMessage({ id: 'm1', sessionId: 'session-abc' }),
      makeMessage({ id: 'm3', sessionId: 'session-abc' }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages.map((m) => m.id)).toEqual(['m1', 'm3'])
  })

  it('sorts messages by createdAt ascending', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'late',
        sessionId: 'session-abc',
        createdAt: '2026-01-03T00:00:00Z',
      }),
      makeMessage({
        id: 'early',
        sessionId: 'session-abc',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'mid',
        sessionId: 'session-abc',
        createdAt: '2026-01-02T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['early', 'mid', 'late'])
  })

  it('returns empty array when data is undefined', () => {
    mockLiveQueryData = undefined
    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages).toEqual([])
  })

  it('maintains sort stability for messages without createdAt', () => {
    mockLiveQueryData = [
      makeMessage({ id: 'm1', sessionId: 'session-abc', createdAt: undefined }),
      makeMessage({ id: 'm2', sessionId: 'session-abc', createdAt: undefined }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    // Should preserve order when no createdAt
    expect(result.current.messages).toHaveLength(2)
  })

  it('re-memoises the collection when sessionId changes', () => {
    mockLiveQueryData = [makeMessage({ id: 'm1', sessionId: 'session-abc' })]

    const { rerender } = renderHook(({ sessionId }) => useMessagesCollection(sessionId), {
      initialProps: { sessionId: 'session-abc' },
    })

    expect(mockCreateMessagesCollection).toHaveBeenCalledWith('session-abc')

    rerender({ sessionId: 'session-xyz' })
    expect(mockCreateMessagesCollection).toHaveBeenCalledWith('session-xyz')
  })

  it('sorts user-turn rows by canonical_turn_id regardless of createdAt', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'usr-2',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-2',
        createdAt: '2026-01-03T00:00:00Z',
      }),
      makeMessage({
        id: 'usr-1',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-04T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-2'])
  })

  it('interleaves assistant/tool rows by createdAt between user turns', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'msg-assist-2',
        sessionId: 'session-abc',
        createdAt: '2026-01-02T00:00:00Z',
      }),
      makeMessage({
        id: 'usr-2',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-2',
        createdAt: '2026-01-03T00:00:00Z',
      }),
      makeMessage({
        id: 'msg-assist-1',
        sessionId: 'session-abc',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'usr-1',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-04T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual([
      'usr-1',
      'usr-2',
      'msg-assist-1',
      'msg-assist-2',
    ])
  })

  // ── spec-31 P4a B8: seq-based primary sort ──────────────────────────

  it('sort-by-seq-primary: two rows with different seq, lower-seq sorts first', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'later-seq',
        sessionId: 'session-abc',
        seq: 10,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'earlier-seq',
        sessionId: 'session-abc',
        seq: 5,
        createdAt: '2026-01-05T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['earlier-seq', 'later-seq'])
  })

  it('sort-by-turn-ordinal-fallback: rows with same seq fall through to turnOrdinal', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'usr-2',
        sessionId: 'session-abc',
        seq: 7,
        canonical_turn_id: 'usr-2',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'usr-1',
        sessionId: 'session-abc',
        seq: 7,
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-05T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-2'])
  })

  it('optimistic-no-seq-sorts-last: row with seq undefined sorts after a row with seq=5', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'optimistic',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-01T00:00:00Z',
        // No `seq`
      }),
      makeMessage({
        id: 'echoed',
        sessionId: 'session-abc',
        seq: 5,
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-05T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    // Stamped row first, optimistic-no-seq last (seq=undefined → Infinity).
    expect(result.current.messages.map((m) => m.id)).toEqual(['echoed', 'optimistic'])
  })

  it('REST-loaded user+assistant turns interleave correctly without seq (msg-N fallback)', () => {
    // Regression: when all rows lack seq (REST-loaded), the secondary sort
    // must parse the message id itself (msg-N → turnOrdinal=N) so assistant
    // rows sort alongside their user turn, not after all user rows.
    mockLiveQueryData = [
      makeMessage({
        id: 'usr-2',
        sessionId: 'session-abc',
        role: 'user',
        canonical_turn_id: 'usr-2',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'msg-2',
        sessionId: 'session-abc',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:01Z',
      }),
      makeMessage({
        id: 'usr-3',
        sessionId: 'session-abc',
        role: 'user',
        canonical_turn_id: 'usr-3',
        createdAt: '2026-01-01T00:00:02Z',
      }),
      makeMessage({
        id: 'msg-3',
        sessionId: 'session-abc',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:03Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    // Expected: usr-2, msg-2, usr-3, msg-3 (interleaved turns, not grouped by role)
    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-2', 'msg-2', 'usr-3', 'msg-3'])
  })

  it('optimistic user rows (usr-client-<uuid>) without canonical_turn_id interleave by createdAt', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'usr-1',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'usr-client-abc',
        sessionId: 'session-abc',
        createdAt: '2026-01-02T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-client-abc'])
  })
})
