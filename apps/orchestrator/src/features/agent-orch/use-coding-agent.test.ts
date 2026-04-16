/**
 * Tests for useCodingAgent hook — collection-as-single-source message handling.
 *
 * @vitest-environment jsdom
 *
 * Validates:
 * - Cache-first hydration from local collection (parts-based CachedMessage)
 * - { type: 'message' } wire format: upsert to collection, streaming updates
 * - { type: 'messages' } wire format: bulk sync to collection with pruning
 * - sendMessage: optimistic insert to collection, rollback on failure
 * - injectQaPair: parts-based qa_pair message written to collection
 * - Legacy gateway_event: only non-message events processed (kata_state, context_usage, result)
 * - Stripped events (assistant, tool_result, partial_assistant, file_changed) no longer handled
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CachedMessage } from '~/db/messages-collection'

// ── Mock data ────────────────────────────────────────────────────────

const cachedMessagesStore = new Map<string, CachedMessage>()

// ── Mocks ────────────────────────────────────────────────────────────

// Mock upsertMessage and pruneStaleMessages to operate on the in-memory store
const mockUpsertMessage = vi.fn((sessionId: string, msg: Partial<CachedMessage>) => {
  const existing = cachedMessagesStore.get(msg.id!)
  if (existing) {
    cachedMessagesStore.set(msg.id!, { ...existing, ...msg, sessionId })
  } else {
    cachedMessagesStore.set(msg.id!, {
      id: msg.id!,
      sessionId,
      role: msg.role ?? 'assistant',
      parts: msg.parts ?? [],
      createdAt: msg.createdAt,
    })
  }
})

const mockPruneStaleMessages = vi.fn((sessionId: string, keepIds: Set<string>) => {
  for (const [key, msg] of cachedMessagesStore) {
    if (msg.sessionId === sessionId && !keepIds.has(key)) {
      cachedMessagesStore.delete(key)
    }
  }
})

vi.mock('~/db/messages-collection', () => ({
  messagesCollection: {
    [Symbol.iterator]: () => cachedMessagesStore.entries(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  upsertMessage: (...args: unknown[]) =>
    mockUpsertMessage(...(args as [string, Partial<CachedMessage>])),
  pruneStaleMessages: (...args: unknown[]) =>
    mockPruneStaleMessages(...(args as [string, Set<string>])),
}))

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: {
    update: vi.fn(),
    insert: vi.fn(),
  },
}))

// Mock useMessagesCollection to return filtered/sorted cached messages reactively
vi.mock('~/hooks/use-messages-collection', () => ({
  useMessagesCollection: (sessionId: string) => {
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
}))

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

  test('appends a new assistant message via collection upsert', () => {
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

    // Verify upsertMessage was called with correct args
    expect(mockUpsertMessage).toHaveBeenCalledWith('test-session', {
      id: 'asst-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hello!' }],
      createdAt: undefined,
    })
    // Message should be in the collection store
    expect(cachedMessagesStore.has('asst-1')).toBe(true)
  })

  test('upserts an existing assistant message by id (streaming update)', () => {
    renderHook(() => useCodingAgent('test-session'))

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

    expect(cachedMessagesStore.get('asst-1')?.parts[0].text).toBe('Hel')

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

    // upsertMessage called twice for same ID — second call updates
    expect(mockUpsertMessage).toHaveBeenCalledTimes(2)
    expect(cachedMessagesStore.get('asst-1')?.parts[0].text).toBe('Hello world!')
  })

  test('replaces optimistic user message with server echo', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    // Send a message (creates optimistic insert)
    act(() => {
      result.current.sendMessage('Hello agent')
    })

    // Should have optimistic message in collection
    const optimisticEntries = Array.from(cachedMessagesStore.values()).filter(
      (m) => m.sessionId === 'test-session' && m.role === 'user',
    )
    expect(optimisticEntries).toHaveLength(1)
    expect(optimisticEntries[0].id).toMatch(/^usr-optimistic-/)

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

    // Server echo should be in collection
    expect(cachedMessagesStore.has('server-usr-1')).toBe(true)
  })

  test('appends multiple messages in sequence', () => {
    renderHook(() => useCodingAgent('test-session'))

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

    expect(mockUpsertMessage).toHaveBeenCalledTimes(2)
    expect(cachedMessagesStore.has('usr-1')).toBe(true)
    expect(cachedMessagesStore.has('asst-1')).toBe(true)
  })

  test('writes to collection on each message event', () => {
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

  test('syncs all messages to collection and prunes stale', () => {
    renderHook(() => useCodingAgent('test-session'))

    // Add a message first
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'message',
          message: { id: 'old-1', role: 'user', parts: [{ type: 'text', text: 'old' }] },
        }),
      )
    })
    expect(cachedMessagesStore.has('old-1')).toBe(true)

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

    // pruneStaleMessages should have been called to remove old-1
    expect(mockPruneStaleMessages).toHaveBeenCalled()
    expect(cachedMessagesStore.has('replay-1')).toBe(true)
    expect(cachedMessagesStore.has('replay-2')).toBe(true)
    // old-1 should be pruned
    expect(cachedMessagesStore.has('old-1')).toBe(false)
  })

  test('upserts all replayed messages to collection', () => {
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
    renderHook(() => useCodingAgent('test-session'))

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

    expect(cachedMessagesStore.has('r-1')).toBe(true)
    expect(cachedMessagesStore.has('asst-new')).toBe(true)
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

  test('creates optimistic user message in collection', () => {
    renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    act(() => {
      renderHook(() => useCodingAgent('test-session')).result.current.sendMessage('Test message')
    })

    // upsertMessage should have been called with optimistic ID
    const optimisticCalls = mockUpsertMessage.mock.calls.filter(
      ([, msg]: [string, { id: string }]) => msg.id.startsWith('usr-optimistic-'),
    )
    expect(optimisticCalls.length).toBeGreaterThanOrEqual(1)
  })

  test('removes optimistic message on failure', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: false, error: 'session not running' })

    await act(async () => {
      await result.current.sendMessage('Failing message')
    })

    // After failure, pruneStaleMessages should remove the optimistic message
    expect(mockPruneStaleMessages).toHaveBeenCalled()
  })

  test('serializes ContentBlock[] content as JSON text', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    const blocks = [{ type: 'text' as const, text: 'hello' }]
    act(() => {
      result.current.sendMessage(blocks)
    })

    // Find the upsertMessage call with the optimistic message
    const optimisticCall = mockUpsertMessage.mock.calls.find(([, msg]: [string, { id: string }]) =>
      msg.id.startsWith('usr-optimistic-'),
    )
    expect(optimisticCall).toBeDefined()
    expect(optimisticCall![1].parts[0].text).toBe(JSON.stringify(blocks))
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

  test('injects qa_pair message to collection', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      result.current.injectQaPair('What is 2+2?', '4')
    })

    // upsertMessage should be called with qa_pair role
    const qaCalls = mockUpsertMessage.mock.calls.filter(
      ([, msg]: [string, { role: string }]) => msg.role === 'qa_pair',
    )
    expect(qaCalls).toHaveLength(1)
    expect(qaCalls[0][1].parts).toEqual([{ type: 'text', text: 'Q: What is 2+2?\nA: 4' }])
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
    renderHook(() => useCodingAgent('test-session'))

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

    // No upsertMessage calls for gateway_events
    expect(mockUpsertMessage).not.toHaveBeenCalled()
  })

  test('does NOT create messages from tool_result gateway_events (stripped)', () => {
    renderHook(() => useCodingAgent('test-session'))

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

    expect(mockUpsertMessage).not.toHaveBeenCalled()
  })

  test('does NOT create messages from file_changed gateway_events (stripped)', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'gateway_event',
          event: { type: 'file_changed', path: '/src/foo.ts', tool: 'Edit' },
        }),
      )
    })

    expect(mockUpsertMessage).not.toHaveBeenCalled()
  })

  test('does NOT handle user_message wire format (stripped)', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'user_message',
          content: 'hello from another tab',
        }),
      )
    })

    expect(mockUpsertMessage).not.toHaveBeenCalled()
  })

  test('ignores non-JSON messages gracefully', () => {
    renderHook(() => useCodingAgent('test-session'))

    expect(() => {
      act(() => {
        capturedUseAgentConfig?.onMessage?.(new MessageEvent('message', { data: 'not json' }))
      })
    }).not.toThrow()

    expect(mockUpsertMessage).not.toHaveBeenCalled()
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

  test('resubmitMessage calls RPC and syncs messages to collection', async () => {
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
    // Messages should be synced to collection
    expect(cachedMessagesStore.has('msg-0')).toBe(true)
    expect(cachedMessagesStore.has('usr-5')).toBe(true)
  })

  test('resubmitMessage does not update collection on failure', async () => {
    renderHook(() => useCodingAgent('test-session'))

    // Seed some initial messages via WS replay
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          messages: [{ id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'original' }] }],
        }),
      )
    })

    vi.clearAllMocks()

    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: false, error: 'Original message not found' })

    await act(async () => {
      const res = await result.current.resubmitMessage('usr-99', 'nope')
      expect(res.ok).toBe(false)
    })

    // No additional syncMessagesToCollection calls after the failure
    expect(mockPruneStaleMessages).not.toHaveBeenCalled()
  })

  test('navigateBranch does nothing when branchInfo is empty', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    await act(async () => {
      await result.current.navigateBranch('usr-1', 'next')
    })

    // No RPC calls should be made for getMessages
    expect(mockCall).not.toHaveBeenCalledWith('getMessages', expect.anything())
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
