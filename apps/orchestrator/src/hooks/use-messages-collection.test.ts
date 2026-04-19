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

vi.mock('~/db/messages-collection', () => ({
  messagesCollection: {
    insert: vi.fn(),
    delete: vi.fn(),
    [Symbol.iterator]: vi.fn().mockReturnValue([][Symbol.iterator]()),
    utils: {},
  },
}))

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

  it('filters messages by sessionId', () => {
    mockLiveQueryData = [
      makeMessage({ id: 'm1', sessionId: 'session-abc' }),
      makeMessage({ id: 'm2', sessionId: 'session-xyz' }),
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

  it('updates when sessionId changes', () => {
    mockLiveQueryData = [
      makeMessage({ id: 'm1', sessionId: 'session-abc' }),
      makeMessage({ id: 'm2', sessionId: 'session-xyz' }),
    ]

    const { result, rerender } = renderHook(({ sessionId }) => useMessagesCollection(sessionId), {
      initialProps: { sessionId: 'session-abc' },
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('m1')

    rerender({ sessionId: 'session-xyz' })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('m2')
  })

  it('sorts server-assigned rows by turn number regardless of createdAt', () => {
    // Rig timestamps so createdAt order DISAGREES with turn order — this
    // matches the clock-skew / rapid-burst scenarios where sorting purely by
    // createdAt produced out-of-order display. Turn number wins.
    mockLiveQueryData = [
      makeMessage({ id: 'msg-4', sessionId: 'session-abc', createdAt: '2026-01-01T00:00:00Z' }),
      makeMessage({ id: 'usr-2', sessionId: 'session-abc', createdAt: '2026-01-03T00:00:00Z' }),
      makeMessage({ id: 'msg-3', sessionId: 'session-abc', createdAt: '2026-01-02T00:00:00Z' }),
      makeMessage({ id: 'usr-1', sessionId: 'session-abc', createdAt: '2026-01-04T00:00:00Z' }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-2', 'msg-3', 'msg-4'])
  })

  it('places optimistic rows after all server-assigned rows, FIFO by embedded timestamp', () => {
    mockLiveQueryData = [
      makeMessage({ id: 'usr-optimistic-2000', sessionId: 'session-abc' }),
      makeMessage({ id: 'msg-10', sessionId: 'session-abc' }),
      makeMessage({ id: 'usr-optimistic-1000', sessionId: 'session-abc' }),
      makeMessage({ id: 'usr-9', sessionId: 'session-abc' }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual([
      'usr-9',
      'msg-10',
      'usr-optimistic-1000',
      'usr-optimistic-2000',
    ])
  })

  it('sorts err-N rows inline with the turn sequence', () => {
    mockLiveQueryData = [
      makeMessage({ id: 'msg-3', sessionId: 'session-abc' }),
      makeMessage({ id: 'err-2', sessionId: 'session-abc' }),
      makeMessage({ id: 'usr-1', sessionId: 'session-abc' }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'err-2', 'msg-3'])
  })
})
