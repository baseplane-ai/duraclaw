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

  // ── GH#38 P1.3 B6: 2-tuple sort `[turnOrdinal, createdAt]` (seq dropped) ──

  it('sort-by-turn-ordinal-primary: lower turnOrdinal sorts first regardless of createdAt', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'usr-2',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-2',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      makeMessage({
        id: 'usr-1',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-05T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-2'])
  })

  it('optimistic-no-ordinal-sorts-last: usr-client-<uuid> pre-echo sorts after canonical rows', () => {
    mockLiveQueryData = [
      makeMessage({
        id: 'usr-client-abc',
        sessionId: 'session-abc',
        createdAt: '2026-01-01T00:00:00Z',
        // No `canonical_turn_id` and id is not parseable as `usr-N`
      }),
      makeMessage({
        id: 'usr-1',
        sessionId: 'session-abc',
        canonical_turn_id: 'usr-1',
        createdAt: '2026-01-05T00:00:00Z',
      }),
    ]

    const { result } = renderHook(() => useMessagesCollection('session-abc'))

    // Canonical row first, optimistic no-ordinal (Infinity) sorts last.
    expect(result.current.messages.map((m) => m.id)).toEqual(['usr-1', 'usr-client-abc'])
  })

  it('REST-loaded user+assistant turns interleave correctly via msg-N id fallback', () => {
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

  // ── Cache-invalidation: optimistic gate resolve must reach the renderer ──
  //
  // Regression for the "submit feels frozen until first assistant message
  // returns" bug. The signature-keyed memo in useMessagesCollection (added
  // in 46d99de Fix B for Virtuoso perf) was keyed only on `[length, id,
  // parts.length, trailing-text length]`. The optimistic gate-resolve path
  // in use-coding-agent flips a non-trailing part's `state` from
  // `input-available` → `output-available` and stamps an `output` field —
  // neither changes parts.length nor trailing text length, so the cached
  // sorted array was returned unchanged and ChatThread kept rendering the
  // GateResolver. The signature must include per-part state + output
  // presence to catch this.

  it('part state transition (gate resolve) returns a new sorted array reference', () => {
    const initial = [
      makeMessage({
        id: 'msg-1',
        sessionId: 'session-abc',
        parts: [
          {
            type: 'tool-AskUserQuestion',
            toolCallId: 'tc-1',
            state: 'input-available',
            input: { question: 'pick one' },
          },
        ],
      }),
    ]
    mockLiveQueryData = initial

    const { result, rerender } = renderHook(() => useMessagesCollection('session-abc'))
    const before = result.current.messages

    // Simulate the optimistic gate resolve: same row id, same parts.length,
    // but the part's state flips and an `output` appears.
    mockLiveQueryData = [
      makeMessage({
        id: 'msg-1',
        sessionId: 'session-abc',
        parts: [
          {
            type: 'tool-AskUserQuestion',
            toolCallId: 'tc-1',
            state: 'output-available',
            input: { question: 'pick one' },
            output: 'option-a',
          },
        ],
      }),
    ]
    rerender()

    const after = result.current.messages

    expect(after).not.toBe(before)
    expect((after[0].parts as Array<{ state: string }>)[0].state).toBe('output-available')
  })

  it('output arrival on a non-trailing tool part returns a new sorted array reference', () => {
    // Same class of bug for generic tool calls — output arrives on a tool
    // part that's followed by a (possibly empty) text part. parts.length
    // unchanged, trailing text length unchanged, but the tool part's state
    // and output both mutate.
    const initial = [
      makeMessage({
        id: 'msg-1',
        sessionId: 'session-abc',
        parts: [
          { type: 'tool-bash', toolCallId: 'tc-1', state: 'input-available', input: 'ls' },
          { type: 'text', text: '' },
        ],
      }),
    ]
    mockLiveQueryData = initial

    const { result, rerender } = renderHook(() => useMessagesCollection('session-abc'))
    const before = result.current.messages

    mockLiveQueryData = [
      makeMessage({
        id: 'msg-1',
        sessionId: 'session-abc',
        parts: [
          {
            type: 'tool-bash',
            toolCallId: 'tc-1',
            state: 'output-available',
            input: 'ls',
            output: 'file1\nfile2',
          },
          { type: 'text', text: '' },
        ],
      }),
    ]
    rerender()

    expect(result.current.messages).not.toBe(before)
  })

  it('truly identical data still returns the cached reference (perf cache intact)', () => {
    // Counterpart to the cache-invalidation tests above — confirm the perf
    // cache from 46d99de still kicks in for the no-op re-render case.
    mockLiveQueryData = [
      makeMessage({
        id: 'msg-1',
        sessionId: 'session-abc',
        parts: [{ type: 'text', text: 'hello' }],
      }),
    ]
    const { result, rerender } = renderHook(() => useMessagesCollection('session-abc'))
    const before = result.current.messages

    // Same `mockLiveQueryData` array reference, no mutation. Hook re-runs,
    // useMemo's `[data]` dep is unchanged so it doesn't recompute — but
    // even if it did (e.g. underlying live-query re-emits the same shape),
    // the signature would match and the cached reference would return.
    rerender()

    expect(result.current.messages).toBe(before)
  })
})
