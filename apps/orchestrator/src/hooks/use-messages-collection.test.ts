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
    created_at: '2026-01-01T00:00:00Z',
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

  it('sorts messages by created_at ascending', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'late',
        sessionId: 'session-abc',
        created_at: '2026-01-03T00:00:00Z',
      }),
      makeMessage({
        id: 'early',
        sessionId: 'session-abc',
        created_at: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'mid',
        sessionId: 'session-abc',
        created_at: '2026-01-02T00:00:00Z',
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

  it('maintains sort stability for messages without created_at', () => {
    mockLiveQueryData = [
      makeMessage({ id: 'm1', sessionId: 'session-abc', created_at: undefined }),
      makeMessage({ id: 'm2', sessionId: 'session-abc', created_at: undefined }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    // Should preserve order when no created_at
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
})
