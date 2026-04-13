/**
 * Tests for message cache-behind writes and cache-first hydration in useCodingAgent.
 *
 * Validates that:
 * - Assistant/tool_result events are written to messagesCollection (cache-behind)
 * - User messages from sendMessage are written to messagesCollection
 * - Hydrated messages are written to messagesCollection
 * - On first state sync, cached messages are loaded before WS hydration (cache-first)
 * - Duplicate insert errors are silently ignored
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

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: {
    update: vi.fn(),
  },
}))

// ── Messages collection mock ──────────────────────────────────────

const mockInsert = vi.fn()
const mockCollectionEntries: Array<[string, Record<string, unknown>]> = []

vi.mock('~/db/messages-collection', () => ({
  messagesCollection: {
    insert: (...args: unknown[]) => mockInsert(...args),
    [Symbol.iterator]: () => mockCollectionEntries[Symbol.iterator](),
  },
}))

// Import after mocks
import { useCodingAgent } from '../use-coding-agent'

function makeWsMessage(data: unknown): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent
}

describe('message cache-behind writes', () => {
  beforeEach(() => {
    capturedOnStateUpdate = null
    capturedOnMessage = null
    vi.clearAllMocks()
    mockCollectionEntries.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('assistant event triggers cache-behind write to messagesCollection', () => {
    renderHook(() => useCodingAgent('test-session'))

    const now = new Date('2026-04-13T12:00:00Z')
    vi.setSystemTime(now)

    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'assistant',
            uuid: 'evt-uuid-1',
            content: [{ type: 'text', text: 'Hello world' }],
          },
        }),
      )
    })

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'evt-uuid-1',
        sessionId: 'test-session',
        role: 'assistant',
        type: 'text',
        content: JSON.stringify([{ type: 'text', text: 'Hello world' }]),
        event_uuid: 'evt-uuid-1',
        created_at: '2026-04-13T12:00:00.000Z',
      }),
    )
  })

  test('tool_result event triggers cache-behind write to messagesCollection', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'tool_result',
            uuid: 'tool-uuid-1',
            content: [{ type: 'tool_result', output: 'done' }],
          },
        }),
      )
    })

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool-tool-uuid-1',
        sessionId: 'test-session',
        role: 'tool',
        type: 'tool_result',
        event_uuid: 'tool-uuid-1',
      }),
    )
  })

  test('partial_assistant events do NOT trigger cache-behind writes', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'partial_assistant',
            content: [{ type: 'text', delta: 'streaming...' }],
          },
        }),
      )
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  test('file_changed events do NOT trigger cache-behind writes', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'file_changed',
            path: '/src/foo.ts',
            tool: 'Edit',
          },
        }),
      )
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  test('user_message broadcasts do NOT trigger cache-behind writes', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'user_message',
          content: 'hello from another tab',
        }),
      )
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  test('sendMessage writes user message to cache', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    await act(async () => {
      await result.current.sendMessage('Hello agent')
    })

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session',
        role: 'user',
        type: 'text',
        content: JSON.stringify('Hello agent'),
      }),
    )
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
          makeWsMessage({
            type: 'gateway_event',
            event: {
              type: 'assistant',
              uuid: 'dup-uuid',
              content: [{ type: 'text', text: 'duplicate' }],
            },
          }),
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
    mockCall.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('loads cached messages from collection on first state sync', () => {
    // Seed the mock collection with cached messages
    mockCollectionEntries.push(
      [
        'cached-1',
        {
          id: 'cached-1',
          sessionId: 'test-session',
          role: 'assistant',
          type: 'text',
          content: '{"text":"cached hello"}',
          event_uuid: 'evt-cached-1',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      [
        'cached-2',
        {
          id: 'cached-2',
          sessionId: 'test-session',
          role: 'user',
          type: 'text',
          content: '"user input"',
          created_at: '2026-01-01T01:00:00Z',
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
          type: 'text',
          content: '"mine"',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      [
        'msg-2',
        {
          id: 'msg-2',
          sessionId: 'other-session',
          role: 'assistant',
          type: 'text',
          content: '"not mine"',
          created_at: '2026-01-01T00:00:00Z',
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

  test('sorts cached messages by created_at', () => {
    mockCollectionEntries.push(
      [
        'late',
        {
          id: 'late',
          sessionId: 'test-session',
          role: 'assistant',
          type: 'text',
          content: '"late"',
          created_at: '2026-01-02T00:00:00Z',
        },
      ],
      [
        'early',
        {
          id: 'early',
          sessionId: 'test-session',
          role: 'assistant',
          type: 'text',
          content: '"early"',
          created_at: '2026-01-01T00:00:00Z',
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
        type: 'text',
        content: '"cached"',
        event_uuid: 'already-known-uuid',
        created_at: '2026-01-01T00:00:00Z',
      },
    ])

    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    // Now send an event with the same uuid -- should be deduped
    act(() => {
      capturedOnMessage!(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'assistant',
            uuid: 'already-known-uuid',
            content: [{ type: 'text', text: 'duplicate' }],
          },
        }),
      )
    })

    // Should still only have the cached message, not a duplicate
    const assistantMsgs = result.current.messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
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
        id: 1,
        role: 'user',
        type: 'text',
        content: '"hello"',
        event_uuid: null,
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 2,
        role: 'assistant',
        type: 'text',
        content: '"hi back"',
        event_uuid: 'hydrated-evt-1',
        created_at: '2026-01-01T01:00:00Z',
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
    // User message uses hydrated-user-{id} format since no event_uuid
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'hydrated-user-1',
        sessionId: 'test-session',
        role: 'user',
        content: '"hello"',
      }),
    )

    // Assistant message uses event_uuid as id
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'hydrated-evt-1',
        sessionId: 'test-session',
        role: 'assistant',
        content: '"hi back"',
        event_uuid: 'hydrated-evt-1',
      }),
    )
  })
})
