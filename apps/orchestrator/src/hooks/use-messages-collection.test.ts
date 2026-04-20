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
    // After P2: the collection itself is per-agentName, so the hook no longer
    // filters — every row in the collection belongs to this session.
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
    // GH#14 P3: user rows carry canonical_turn_id = 'usr-N'; assistant rows
    // interleave by createdAt. Rig timestamps so createdAt DISAGREES with
    // turn order to prove the ordinal wins for user rows.
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
    // Assistant rows have no canonical_turn_id — they sort by createdAt at
    // [Infinity, ts] so the browser sees user turns first, then assistant
    // rows by time.
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

    // Sort key: [ord,0] for usr-1/usr-2; [Inf, ts] for msg-assist-1/msg-assist-2
    expect(result.current.messages.map((m) => m.id)).toEqual([
      'usr-1',
      'usr-2',
      'msg-assist-1',
      'msg-assist-2',
    ])
  })

  it('optimistic user rows (usr-client-<uuid>) without canonical_turn_id interleave by createdAt', () => {
    // Until the server echo arrives, an optimistic row has no
    // canonical_turn_id; it falls through to the createdAt branch and sits
    // at the tail of the thread. Once the echo updates the row with the
    // canonical id, the same row pops into its turn slot.
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
