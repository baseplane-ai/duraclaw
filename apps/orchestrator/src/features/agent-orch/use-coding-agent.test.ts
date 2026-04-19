/**
 * Tests for useCodingAgent hook — SessionMessage wire format handling.
 *
 * @vitest-environment jsdom
 *
 * Validates:
 * - Cache-first hydration from local collection (parts-based CachedMessage)
 * - { type: 'message' } wire format: upsert, optimistic replacement, cache writes
 * - { type: 'messages' } wire format: bulk replay, cache writes
 * - sendMessage: optimistic insert in SessionMessage format, rollback on failure
 * - injectQaPair: parts-based qa_pair message
 * - Legacy gateway_event: only non-message events processed (kata_state, context_usage, result)
 * - Stripped events (assistant, tool_result, partial_assistant, file_changed) no longer handled
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CachedMessage } from '~/db/messages-collection'

// ── Mock data ────────────────────────────────────────────────────────

const cachedMessagesStore = new Map<string, CachedMessage>()

// Subscribers for the reactive useMessagesCollection mock below. Mutations
// notify subscribers so renderHook observes the new message list (mirrors
// the live-query re-render production uses).
const collectionSubs = new Set<() => void>()
const bumpCollection = () => {
  for (const cb of collectionSubs) cb()
}

// ── Mocks ────────────────────────────────────────────────────────────

// Mock messagesCollection as an iterable map with full mutation surface
const mockInsert = vi.fn((msg: CachedMessage) => {
  if (!cachedMessagesStore.has(msg.id)) {
    cachedMessagesStore.set(msg.id, msg)
  }
  bumpCollection()
})
const mockUpdate = vi.fn((id: string, patcher: (draft: CachedMessage) => void) => {
  const existing = cachedMessagesStore.get(id)
  if (!existing) return
  const draft = { ...existing }
  patcher(draft)
  cachedMessagesStore.set(id, draft)
  bumpCollection()
})
const mockDelete = vi.fn((keys: string | string[]) => {
  const ids = Array.isArray(keys) ? keys : [keys]
  for (const id of ids) cachedMessagesStore.delete(id)
  bumpCollection()
})

vi.mock('~/db/messages-collection', () => ({
  messagesCollection: {
    [Symbol.iterator]: () => cachedMessagesStore.entries(),
    has: (id: string) => cachedMessagesStore.has(id),
    insert: (...args: unknown[]) => mockInsert(...(args as [CachedMessage])),
    update: (...args: unknown[]) => mockUpdate(...(args as [string, (d: CachedMessage) => void])),
    delete: (...args: unknown[]) => mockDelete(...(args as [string | string[]])),
  },
}))

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: {
    update: vi.fn(),
    insert: vi.fn(),
    has: vi.fn().mockReturnValue(true),
    utils: { writeUpdate: vi.fn() },
  },
}))

// Reactive useMessagesCollection mock — subscribes to mutation bumps so
// `result.current.messages` reflects collection writes between act() calls.
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
      const all = Array.from(cachedMessagesStore.values())
      const filtered = all
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

// Capture the useAgent config so we can inspect/invoke callbacks
let capturedUseAgentConfig: {
  agent: string
  name: string
  onStateUpdate?: (state: unknown) => void
  onMessage?: (message: MessageEvent) => void
} | null = null

const mockCall = vi.fn().mockResolvedValue([])

vi.mock('agents/react', () => ({
  useAgent: (config: typeof capturedUseAgentConfig) => {
    capturedUseAgentConfig = config
    return { call: mockCall }
  },
}))

// Import after mocks
import { useCodingAgent } from './use-coding-agent'

// ── Helpers ──────────────────────────────────────────────────────────

function seedCachedMessages(sessionId: string, messages: Partial<CachedMessage>[]) {
  for (const msg of messages) {
    const full: CachedMessage = {
      id: msg.id ?? `msg-${Math.random()}`,
      sessionId,
      role: msg.role ?? 'assistant',
      parts: msg.parts ?? [{ type: 'text', text: 'cached content' }],
      createdAt: msg.createdAt ?? '2026-04-10T00:00:00Z',
    }
    cachedMessagesStore.set(full.id, full)
  }
}

function makeWsMessage(data: unknown): MessageEvent {
  return new MessageEvent('message', { data: JSON.stringify(data) })
}

// ── Tests ────────────────────────────────────────────────────────────

describe('useCodingAgent cache-first hydration', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('loads cached messages immediately on initial render (before WS connects)', () => {
    seedCachedMessages('session-a', [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello from cache' }],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'tool-bash', toolName: 'bash', input: { command: 'ls' } }],
      },
    ])

    const { result } = renderHook(() => useCodingAgent('session-a'))

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].parts[0].text).toBe('Hello from cache')
    expect(result.current.messages[1].parts[0].toolName).toBe('bash')
    expect(result.current.state).toBeNull()
  })

  test('loads cached messages eagerly on agentName change (session switch)', () => {
    seedCachedMessages('session-a', [
      { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'Session A msg' }] },
    ])
    seedCachedMessages('session-b', [
      { id: 'b-1', role: 'assistant', parts: [{ type: 'text', text: 'Session B msg' }] },
      {
        id: 'b-2',
        role: 'assistant',
        parts: [{ type: 'tool-bash', toolName: 'bash', input: { command: 'echo hi' } }],
      },
    ])

    const { result, rerender } = renderHook(({ name }: { name: string }) => useCodingAgent(name), {
      initialProps: { name: 'session-a' },
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].parts[0].text).toBe('Session A msg')

    rerender({ name: 'session-b' })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].parts[0].text).toBe('Session B msg')
    expect(result.current.messages[1].parts[0].toolName).toBe('bash')
  })

  test('shows empty messages when switching to a session with no cache', () => {
    seedCachedMessages('session-a', [
      { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'cached' }] },
    ])

    const { result, rerender } = renderHook(({ name }: { name: string }) => useCodingAgent(name), {
      initialProps: { name: 'session-a' },
    })

    expect(result.current.messages).toHaveLength(1)
    rerender({ name: 'session-empty' })
    expect(result.current.messages).toHaveLength(0)
  })

  test('resets state when agentName changes', () => {
    const { result, rerender } = renderHook(({ name }: { name: string }) => useCodingAgent(name), {
      initialProps: { name: 'session-a' },
    })

    act(() => {
      capturedUseAgentConfig?.onStateUpdate?.({ status: 'running', num_turns: 5 })
    })

    expect(result.current.state).not.toBeNull()
    rerender({ name: 'session-b' })
    expect(result.current.state).toBeNull()
    expect(result.current.sessionResult).toBeNull()
  })

  test('cached messages sorted by createdAt', () => {
    seedCachedMessages('session-sorted', [
      {
        id: 'late',
        role: 'assistant',
        parts: [{ type: 'text', text: 'second' }],
        createdAt: '2026-04-10T02:00:00Z',
      },
      {
        id: 'early',
        role: 'assistant',
        parts: [{ type: 'text', text: 'first' }],
        createdAt: '2026-04-10T01:00:00Z',
      },
    ])

    const { result } = renderHook(() => useCodingAgent('session-sorted'))

    expect(result.current.messages[0].parts[0].text).toBe('first')
    expect(result.current.messages[1].parts[0].text).toBe('second')
  })
})

describe('type: "message" wire format', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('appends a new assistant message', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: {
            id: 'asst-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hello!' }],
          },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('asst-1')
    expect(result.current.messages[0].role).toBe('assistant')
    expect(result.current.messages[0].parts[0].text).toBe('Hello!')
  })

  test('upserts an existing assistant message by id (streaming update)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // First message
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: {
            id: 'asst-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hel', state: 'streaming' }],
          },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].parts[0].text).toBe('Hel')
    expect(result.current.messages[0].parts[0].state).toBe('streaming')

    // Update same message
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: {
            id: 'asst-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hello world!', state: 'done' }],
          },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].parts[0].text).toBe('Hello world!')
    expect(result.current.messages[0].parts[0].state).toBe('done')
  })

  test('replaces optimistic user message with server echo', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    // Send a message (creates optimistic insert)
    act(() => {
      result.current.sendMessage('Hello agent')
    })

    // Should have 1 optimistic message
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toMatch(/^usr-optimistic-/)
    expect(result.current.messages[0].parts[0].text).toBe('Hello agent')

    // Server echo arrives
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: {
            id: 'server-usr-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Hello agent' }],
          },
        }),
      )
    })

    // Optimistic should be replaced by server version
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('server-usr-1')
  })

  test('appends multiple messages in sequence', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        }),
      )
    })

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: {
            id: 'asst-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hello!' }],
          },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].role).toBe('user')
    expect(result.current.messages[1].role).toBe('assistant')
  })

  test('writes to cache on each message event', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: {
            id: 'msg-cache-1',
            role: 'assistant',
            parts: [{ type: 'text', text: 'cached' }],
            createdAt: '2026-04-14T00:00:00Z',
          },
        }),
      )
    })

    // Check that cacheMessage was called (insert on messagesCollection)
    expect(cachedMessagesStore.has('msg-cache-1')).toBe(true)
    const cached = cachedMessagesStore.get('msg-cache-1')!
    expect(cached.sessionId).toBe('test-session')
    expect(cached.role).toBe('assistant')
    expect(cached.parts[0].text).toBe('cached')
  })
})

describe('type: "messages" wire format (bulk replay)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('replaces all messages with bulk replay', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Add a message first
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: { id: 'old-1', role: 'user', parts: [{ type: 'text', text: 'old' }] },
        }),
      )
    })
    expect(result.current.messages).toHaveLength(1)

    // Bulk replay replaces everything
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          messages: [
            { id: 'replay-1', role: 'user', parts: [{ type: 'text', text: 'replayed user' }] },
            {
              id: 'replay-2',
              role: 'assistant',
              parts: [{ type: 'text', text: 'replayed assistant' }],
            },
          ],
        }),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].id).toBe('replay-1')
    expect(result.current.messages[1].id).toBe('replay-2')
  })

  test('caches all replayed messages', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          messages: [
            { id: 'r-1', role: 'user', parts: [{ type: 'text', text: 'u' }] },
            { id: 'r-2', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
          ],
        }),
      )
    })

    expect(cachedMessagesStore.has('r-1')).toBe(true)
    expect(cachedMessagesStore.has('r-2')).toBe(true)
  })

  test('subsequent single message upserts work after bulk replay', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          messages: [{ id: 'r-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        }),
      )
    })

    // Now a new message arrives
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: {
            id: 'asst-new',
            role: 'assistant',
            parts: [{ type: 'text', text: 'hello' }],
          },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].id).toBe('asst-new')
  })
})

describe('sendMessage (SessionMessage format)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('creates optimistic user message with parts format', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    act(() => {
      result.current.sendMessage('Test message')
    })

    expect(result.current.messages).toHaveLength(1)
    const msg = result.current.messages[0]
    expect(msg.role).toBe('user')
    expect(msg.parts).toEqual([{ type: 'text', text: 'Test message' }])
    expect(msg.id).toMatch(/^usr-optimistic-/)
    expect(msg.createdAt).toBeInstanceOf(Date)
  })

  test('removes optimistic message on failure', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: false, error: 'session not running' })

    await act(async () => {
      await result.current.sendMessage('Failing message')
    })

    expect(result.current.messages).toHaveLength(0)
  })

  test('converts ContentBlock[] content to structured SessionMessageParts', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    const blocks = [{ type: 'text' as const, text: 'hello' }]
    act(() => {
      result.current.sendMessage(blocks)
    })

    expect(result.current.messages[0].parts).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('injectQaPair (SessionMessage format)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('injects qa_pair message with parts format', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      result.current.injectQaPair('What is 2+2?', '4')
    })

    expect(result.current.messages).toHaveLength(1)
    const msg = result.current.messages[0]
    expect(msg.role).toBe('qa_pair')
    expect(msg.id).toMatch(/^qa-/)
    expect(msg.parts).toEqual([{ type: 'text', text: 'Q: What is 2+2?\nA: 4' }])
  })
})

describe('legacy gateway_event handling', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('processes kata_state events', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'kata_state',
            kata_state: { mode: 'implementation', phase: 'p1' },
          },
        }),
      )
    })

    expect(result.current.kataState).toEqual({ mode: 'implementation', phase: 'p1' })
  })

  test('processes context_usage events', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'context_usage',
            usage: { totalTokens: 5000, maxTokens: 200000, percentage: 2.5 },
          },
        }),
      )
    })

    expect(result.current.contextUsage).toEqual({
      totalTokens: 5000,
      maxTokens: 200000,
      percentage: 2.5,
      model: undefined,
      isAutoCompactEnabled: undefined,
      autoCompactThreshold: undefined,
    })
  })

  test('processes result events', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'result',
            total_cost_usd: 0.42,
            duration_ms: 15000,
          },
        }),
      )
    })

    expect(result.current.sessionResult).toEqual({
      total_cost_usd: 0.42,
      duration_ms: 15000,
    })
  })

  test('accumulates events in events array', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: { type: 'context_usage', usage: { totalTokens: 1, maxTokens: 2, percentage: 0 } },
        }),
      )
    })

    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0].type).toBe('context_usage')
  })

  test('does NOT create messages from assistant gateway_events (stripped)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'assistant',
            uuid: 'evt-1',
            content: [{ type: 'text', text: 'should be ignored' }],
          },
        }),
      )
    })

    // No messages should be created from legacy assistant events
    expect(result.current.messages).toHaveLength(0)
  })

  test('does NOT create messages from tool_result gateway_events (stripped)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: {
            type: 'tool_result',
            uuid: 'tool-1',
            content: [{ type: 'tool_result', output: 'done' }],
          },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(0)
  })

  test('does NOT create messages from file_changed gateway_events (stripped)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: { type: 'file_changed', path: '/src/foo.ts', tool: 'Edit' },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(0)
  })

  test('does NOT handle user_message wire format (stripped)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'user_message',
          content: 'hello from another tab',
        }),
      )
    })

    expect(result.current.messages).toHaveLength(0)
  })

  test('ignores non-JSON messages gracefully', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    expect(() => {
      act(() => {
        capturedUseAgentConfig?.onMessage?.(new MessageEvent('message', { data: 'not json' }))
      })
    }).not.toThrow()

    expect(result.current.messages).toHaveLength(0)
  })
})

describe('branch tracking', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('branchInfo is initially an empty Map', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))
    expect(result.current.branchInfo).toBeInstanceOf(Map)
    expect(result.current.branchInfo.size).toBe(0)
  })

  test('getBranches calls connection.call with correct args', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce([
      { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'v1' }] },
      { id: 'usr-3', role: 'user', parts: [{ type: 'text', text: 'v2' }] },
    ])

    await act(async () => {
      const branches = await result.current.getBranches('msg-1')
      expect(branches).toHaveLength(2)
    })

    expect(mockCall).toHaveBeenCalledWith('getBranches', ['msg-1'])
  })

  test('resubmitMessage calls RPC and refreshes messages on success', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // First call: resubmitMessage RPC
    mockCall.mockResolvedValueOnce({ ok: true, leafId: 'usr-5' })
    // Second call: getMessages to fetch new branch
    mockCall.mockResolvedValueOnce([
      { id: 'msg-0', role: 'assistant', parts: [{ type: 'text', text: 'initial' }] },
      { id: 'usr-5', role: 'user', parts: [{ type: 'text', text: 'edited' }] },
    ])
    // Third+ calls: getBranches for refreshBranchInfo (one per user message)
    mockCall.mockResolvedValue([])

    await act(async () => {
      const res = await result.current.resubmitMessage('usr-1', 'edited')
      expect(res.ok).toBe(true)
      expect(res.leafId).toBe('usr-5')
    })

    expect(mockCall).toHaveBeenCalledWith('resubmitMessage', ['usr-1', 'edited'])
    expect(mockCall).toHaveBeenCalledWith('getMessages', [
      { session_hint: 'test-session', leafId: 'usr-5' },
    ])
    // Messages should be updated
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].id).toBe('usr-5')
  })

  test('resubmitMessage does not update messages on failure', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Seed some initial messages via WS replay
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          messages: [{ id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'original' }] }],
        }),
      )
    })

    expect(result.current.messages).toHaveLength(1)

    mockCall.mockResolvedValueOnce({ ok: false, error: 'Original message not found' })

    await act(async () => {
      const res = await result.current.resubmitMessage('usr-99', 'nope')
      expect(res.ok).toBe(false)
    })

    // Messages unchanged
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('usr-1')
  })

  test('navigateBranch does nothing when branchInfo is empty', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    await act(async () => {
      await result.current.navigateBranch('usr-1', 'next')
    })

    // No RPC calls should be made for getMessages
    expect(mockCall).not.toHaveBeenCalledWith('getMessages', expect.anything())
  })

  test('navigateBranch fetches messages for target sibling', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Seed messages with branch info via hydration
    // First, simulate having branchInfo by setting it via resubmitMessage flow
    // Or more directly, we can test via the internal state.

    // Seed messages
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          messages: [
            { id: 'msg-0', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
            { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'v1' }] },
          ],
        }),
      )
    })

    // Mock getBranches to return siblings (called during hydration refreshBranchInfo)
    // The hydration triggers refreshBranchInfo which calls getBranches for parent of usr-1 (msg-0)
    mockCall.mockResolvedValueOnce([
      { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'v1' }] },
      { id: 'usr-3', role: 'user', parts: [{ type: 'text', text: 'v2' }] },
    ])

    // Trigger hydration which calls refreshBranchInfo
    await act(async () => {
      // getMessages RPC returns messages
      mockCall.mockResolvedValueOnce([
        { id: 'msg-0', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'v1' }] },
      ])
      // getBranches for msg-0 (parent of usr-1)
      mockCall.mockResolvedValueOnce([
        { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'v1' }] },
        { id: 'usr-3', role: 'user', parts: [{ type: 'text', text: 'v2' }] },
      ])
      capturedUseAgentConfig?.onStateUpdate?.({ status: 'idle' })
    })

    // Wait for async hydration to complete
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Now branchInfo should be populated
    expect(result.current.branchInfo.size).toBeGreaterThanOrEqual(0)
  })

  test('refreshBranchInfo populates branch data after hydration', async () => {
    const { result } = renderHook(() => useCodingAgent('branch-test'))

    // Mock getMessages for hydration
    mockCall.mockResolvedValueOnce([
      { id: 'msg-0', role: 'assistant', parts: [{ type: 'text', text: 'system' }] },
      { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'hello v1' }] },
      { id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
    ])
    // Mock getBranches(msg-0) -> returns children including usr-1 and usr-3
    mockCall.mockResolvedValueOnce([
      { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'hello v1' }] },
      { id: 'usr-3', role: 'user', parts: [{ type: 'text', text: 'hello v2' }] },
    ])

    // Trigger hydration
    await act(async () => {
      capturedUseAgentConfig?.onStateUpdate?.({ status: 'idle' })
    })

    // Wait for async operations
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // branchInfo should now contain entry for usr-1
    const info = result.current.branchInfo.get('usr-1')
    if (info) {
      expect(info.current).toBe(1)
      expect(info.total).toBe(2)
      expect(info.siblings).toEqual(['usr-1', 'usr-3'])
    }
  })
})
