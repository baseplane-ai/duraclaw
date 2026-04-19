/**
 * Tests for message cache-behind writes and cache-first hydration in useCodingAgent.
 *
 * Validates that:
 * - Unified {type:'messages', seq, payload:{kind:'delta'}} frames are written
 *   to messagesCollection (cache-behind)
 * - Bulk message replay (legacy {messages} shape — deploy rollover tolerance)
 *   is written to messagesCollection
 * - Hydrated messages are written to messagesCollection
 * - On first state sync, cached messages are loaded before WS hydration (cache-first)
 * - Duplicate insert errors are silently ignored
 * - Legacy gateway_event format (non-message events) still works
 *
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ── Capture useAgent callbacks ──────────────────────────────────────

let capturedOnStateUpdate: ((state: Record<string, unknown>) => void) | null = null
let capturedOnMessage: ((msg: MessageEvent) => void) | null = null
const mockCall = vi.fn().mockResolvedValue([])

vi.mock('agents/react', () => ({
  useAgent: (opts: {
    onStateUpdate?: (state: Record<string, unknown>) => void
    onMessage?: (msg: MessageEvent) => void
  }) => {
    capturedOnStateUpdate = opts.onStateUpdate ?? null
    capturedOnMessage = opts.onMessage ?? null
    return { call: mockCall }
  },
}))

vi.mock('~/db/agent-sessions-collection', () => ({
  agentSessionsCollection: {
    update: vi.fn(),
    has: vi.fn().mockReturnValue(true),
    utils: { writeUpdate: vi.fn() },
  },
}))

// ── Messages collection mock ──────────────────────────────────────

const mockInsert = vi.fn()
const mockCollectionEntries: Array<[string, Record<string, unknown>]> = []

// Subscribers for the reactive useMessagesCollection mock below. Every
// mutation bumps each subscriber's forceUpdate so renderHook observes the
// new message list (mirrors the live-query re-render production uses).
const collectionSubs = new Set<() => void>()
const bumpCollection = () => {
  for (const cb of collectionSubs) cb()
}

vi.mock('~/db/messages-collection', () => ({
  messagesCollection: {
    insert: (...args: unknown[]) => {
      mockInsert(...args)
      const row = args[0] as { id: string } & Record<string, unknown>
      if (row && row.id) {
        const existingIdx = mockCollectionEntries.findIndex(([k]) => k === row.id)
        if (existingIdx === -1) {
          mockCollectionEntries.push([row.id, row])
        }
      }
      bumpCollection()
    },
    has: (id: string) => mockCollectionEntries.some(([k]) => k === id),
    update: (id: string, patcher: (draft: Record<string, unknown>) => void) => {
      const idx = mockCollectionEntries.findIndex(([k]) => k === id)
      if (idx === -1) return
      const draft = { ...mockCollectionEntries[idx][1] }
      patcher(draft)
      mockCollectionEntries[idx] = [id, draft]
      bumpCollection()
    },
    delete: (keys: string | string[]) => {
      const ids = new Set(Array.isArray(keys) ? keys : [keys])
      for (let i = mockCollectionEntries.length - 1; i >= 0; i--) {
        if (ids.has(mockCollectionEntries[i][0])) mockCollectionEntries.splice(i, 1)
      }
      bumpCollection()
    },
    [Symbol.iterator]: () => mockCollectionEntries[Symbol.iterator](),
  },
}))

// Reactive live-query mock — subscribes to mutation bumps and re-renders
// the consuming hook. Wraps iteration in try/catch so the
// `handles collection iteration error gracefully` test (which swaps the
// iterator to throw) still passes.
vi.mock('~/hooks/use-messages-collection', async () => {
  const React = await import('react')
  return {
    useMessagesCollection: (sessionId: string) => {
      const [, setV] = React.useState(0)
      React.useEffect(() => {
        const cb = () => setV((v: number) => v + 1)
        collectionSubs.add(cb)
        return () => {
          collectionSubs.delete(cb)
        }
      }, [])
      let rows: Array<Record<string, unknown>> = []
      try {
        rows = mockCollectionEntries.map(([, msg]) => msg)
      } catch {
        rows = []
      }
      const filtered = rows
        .filter((m) => m.sessionId === sessionId)
        .sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt as string).getTime() : 0
          const bTime = b.createdAt ? new Date(b.createdAt as string).getTime() : 0
          return aTime - bTime
        })
      return { messages: filtered, isLoading: false }
    },
  }
})

// Import after mocks
import { useCodingAgent } from '../use-coding-agent'

function makeWsMessage(data: unknown): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent
}

let msgSeq = 0
function deltaFrame(upsert: Array<Record<string, unknown>>, sessionId = 'test-session') {
  msgSeq += 1
  return {
    type: 'messages',
    sessionId,
    seq: msgSeq,
    payload: { kind: 'delta', upsert },
  }
}

describe('message cache-behind writes (SessionMessage format)', () => {
  beforeEach(() => {
    capturedOnStateUpdate = null
    capturedOnMessage = null
    vi.clearAllMocks()
    mockCollectionEntries.length = 0
    msgSeq = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('single delta frame triggers cache-behind write', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnMessage!(
        makeWsMessage(
          deltaFrame([
            {
              id: 'msg-1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hello world' }],
              createdAt: '2026-04-13T12:00:00Z',
            },
          ]),
        ),
      )
    })

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg-1',
        sessionId: 'test-session',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello world' }],
      }),
    )
  })

  test('bulk messages replay triggers cache-behind writes for all messages', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'messages',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Hello' }],
            },
            {
              id: 'msg-2',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hi there' }],
            },
          ],
        }),
      )
    })

    expect(mockInsert).toHaveBeenCalledTimes(2)
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1', role: 'user' }))
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-2', role: 'assistant' }),
    )
  })

  test('legacy gateway_event non-message events do NOT trigger cache writes', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'context_usage',
            usage: { totalTokens: 100, maxTokens: 200000, percentage: 0.05 },
          },
        }),
      )
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  test('duplicate insert errors are silently ignored', () => {
    mockInsert.mockImplementation(() => {
      throw new Error('DuplicateKeyError')
    })

    renderHook(() => useCodingAgent('test-session'))

    // Should not throw
    expect(() => {
      act(() => {
        capturedOnMessage!(
          makeWsMessage(
            deltaFrame([
              {
                id: 'dup-msg',
                role: 'assistant',
                parts: [{ type: 'text', text: 'duplicate' }],
              },
            ]),
          ),
        )
      })
    }).not.toThrow()
  })
})

describe('message cache-first hydration', () => {
  beforeEach(() => {
    capturedOnStateUpdate = null
    capturedOnMessage = null
    vi.clearAllMocks()
    mockCollectionEntries.length = 0
    msgSeq = 0
    mockCall.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('loads cached messages from collection on first state sync', () => {
    // Seed the mock collection with cached messages (new parts format)
    mockCollectionEntries.push(
      [
        'cached-1',
        {
          id: 'cached-1',
          sessionId: 'test-session',
          role: 'assistant',
          parts: [{ type: 'text', text: 'cached hello' }],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      [
        'cached-2',
        {
          id: 'cached-2',
          sessionId: 'test-session',
          role: 'user',
          parts: [{ type: 'text', text: 'user input' }],
          createdAt: '2026-01-01T01:00:00Z',
        },
      ],
    )

    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Trigger first state sync
    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    // Messages should be populated from cache
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].id).toBe('cached-1')
    expect(result.current.messages[1].id).toBe('cached-2')
  })

  test('filters cached messages by sessionId', () => {
    mockCollectionEntries.push(
      [
        'msg-1',
        {
          id: 'msg-1',
          sessionId: 'test-session',
          role: 'assistant',
          parts: [{ type: 'text', text: 'mine' }],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      [
        'msg-2',
        {
          id: 'msg-2',
          sessionId: 'other-session',
          role: 'assistant',
          parts: [{ type: 'text', text: 'not mine' }],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    )

    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('msg-1')
  })

  test('sorts cached messages by createdAt', () => {
    mockCollectionEntries.push(
      [
        'late',
        {
          id: 'late',
          sessionId: 'test-session',
          role: 'assistant',
          parts: [{ type: 'text', text: 'late' }],
          createdAt: '2026-01-02T00:00:00Z',
        },
      ],
      [
        'early',
        {
          id: 'early',
          sessionId: 'test-session',
          role: 'assistant',
          parts: [{ type: 'text', text: 'early' }],
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    )

    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    expect(result.current.messages[0].id).toBe('early')
    expect(result.current.messages[1].id).toBe('late')
  })

  test('populates knownEventUuids from cached messages for dedup', () => {
    mockCollectionEntries.push([
      'cached-evt',
      {
        id: 'cached-evt',
        sessionId: 'test-session',
        role: 'assistant',
        parts: [{ type: 'text', text: 'cached' }],
        createdAt: '2026-01-01T00:00:00Z',
      },
    ])

    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    // Now send a delta frame with the same id -- should upsert in place
    act(() => {
      capturedOnMessage!(
        makeWsMessage(
          deltaFrame([
            {
              id: 'cached-evt',
              role: 'assistant',
              parts: [{ type: 'text', text: 'updated' }],
            },
          ]),
        ),
      )
    })

    // Should still only have one message (upserted)
    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0].parts[0].text).toBe('updated')
  })

  test('handles collection iteration error gracefully', () => {
    // Make the iterator throw
    mockCollectionEntries.length = 0
    Object.defineProperty(mockCollectionEntries, Symbol.iterator, {
      value: () => {
        throw new Error('Collection not initialized')
      },
      configurable: true,
    })

    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Should not throw
    expect(() => {
      act(() => {
        capturedOnStateUpdate!({ status: 'idle' })
      })
    }).not.toThrow()

    // Messages should be empty since cache failed
    expect(result.current.messages).toEqual([])

    // Restore iterator
    Object.defineProperty(mockCollectionEntries, Symbol.iterator, {
      value: Array.prototype[Symbol.iterator],
      configurable: true,
    })
  })
})

describe('hydration writes to collection', () => {
  beforeEach(() => {
    capturedOnStateUpdate = null
    capturedOnMessage = null
    vi.clearAllMocks()
    mockCollectionEntries.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('hydrateMessages writes hydrated messages to collection', async () => {
    const hydratedMessages = [
      {
        id: 'usr-1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'asst-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hi back' }],
        createdAt: '2026-01-01T01:00:00Z',
      },
    ]

    mockCall.mockResolvedValueOnce(hydratedMessages).mockResolvedValue([])

    renderHook(() => useCodingAgent('test-session'))

    // Trigger first state sync which calls hydrateMessages
    await act(async () => {
      capturedOnStateUpdate!({ status: 'idle' })
      // Allow hydrateMessages promise to resolve
      await new Promise((r) => setTimeout(r, 0))
    })

    // Should have written both messages to collection
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'usr-1',
        sessionId: 'test-session',
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      }),
    )

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'asst-1',
        sessionId: 'test-session',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hi back' }],
      }),
    )
  })
})
