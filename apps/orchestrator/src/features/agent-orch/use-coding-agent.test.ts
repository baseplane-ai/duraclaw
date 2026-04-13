/**
 * Tests for useCodingAgent hook — cache-first message hydration on session switch.
 *
 * @vitest-environment jsdom
 *
 * Validates that when agentName changes (session switch), cached messages
 * from the messagesCollection are loaded eagerly via useEffect, before
 * the WebSocket connects and onStateUpdate fires.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CachedMessage } from '~/db/messages-collection'

// ── Mock data ────────────────────────────────────────────────────────

const cachedMessagesStore = new Map<string, CachedMessage>()

// ── Mocks ────────────────────────────────────────────────────────────

// Mock messagesCollection as an iterable map with insert
vi.mock('~/db/messages-collection', () => ({
  messagesCollection: {
    [Symbol.iterator]: () => cachedMessagesStore.entries(),
    insert: vi.fn((msg: CachedMessage) => {
      cachedMessagesStore.set(msg.id, msg)
    }),
  },
}))

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: {
    update: vi.fn(),
    insert: vi.fn(),
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
      type: msg.type ?? 'text',
      content: msg.content ?? 'cached content',
      event_uuid: msg.event_uuid,
      created_at: msg.created_at ?? '2026-04-10T00:00:00Z',
    }
    cachedMessagesStore.set(full.id, full)
  }
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
      { id: 'msg-1', role: 'assistant', content: 'Hello from cache', event_uuid: 'uuid-1' },
      {
        id: 'msg-2',
        role: 'tool',
        type: 'tool_result',
        content: '{"result": true}',
        event_uuid: 'uuid-2',
      },
    ])

    const { result } = renderHook(() => useCodingAgent('session-a'))

    // Messages should be populated from cache without any WS interaction
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].content).toBe('Hello from cache')
    expect(result.current.messages[1].content).toBe('{"result": true}')
    // State should still be null (no WS state update yet)
    expect(result.current.state).toBeNull()
  })

  test('loads cached messages eagerly on agentName change (session switch)', () => {
    seedCachedMessages('session-a', [
      { id: 'a-1', role: 'assistant', content: 'Session A msg', event_uuid: 'a-uuid-1' },
    ])
    seedCachedMessages('session-b', [
      { id: 'b-1', role: 'assistant', content: 'Session B msg', event_uuid: 'b-uuid-1' },
      { id: 'b-2', role: 'tool', content: 'tool output', event_uuid: 'b-uuid-2' },
    ])

    const { result, rerender } = renderHook(({ name }: { name: string }) => useCodingAgent(name), {
      initialProps: { name: 'session-a' },
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].content).toBe('Session A msg')

    // Switch to session-b
    rerender({ name: 'session-b' })

    // Should immediately show session-b cached messages, not "empty"
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].content).toBe('Session B msg')
    expect(result.current.messages[1].content).toBe('tool output')
  })

  test('shows empty messages when switching to a session with no cache', () => {
    seedCachedMessages('session-a', [
      { id: 'a-1', role: 'assistant', content: 'cached', event_uuid: 'a-uuid' },
    ])

    const { result, rerender } = renderHook(({ name }: { name: string }) => useCodingAgent(name), {
      initialProps: { name: 'session-a' },
    })

    expect(result.current.messages).toHaveLength(1)

    // Switch to session with no cached messages
    rerender({ name: 'session-empty' })

    expect(result.current.messages).toHaveLength(0)
  })

  test('resets state when agentName changes', () => {
    const { result, rerender } = renderHook(({ name }: { name: string }) => useCodingAgent(name), {
      initialProps: { name: 'session-a' },
    })

    // Simulate WS state update for session-a
    act(() => {
      capturedUseAgentConfig?.onStateUpdate?.({
        status: 'running',
        num_turns: 5,
      })
    })

    expect(result.current.state).not.toBeNull()

    // Switch sessions
    rerender({ name: 'session-b' })

    // State should be reset
    expect(result.current.state).toBeNull()
    expect(result.current.streamingContent).toBe('')
    expect(result.current.sessionResult).toBeNull()
  })

  test('cached messages sorted by created_at', () => {
    seedCachedMessages('session-sorted', [
      {
        id: 'late',
        role: 'assistant',
        content: 'second',
        event_uuid: 'u2',
        created_at: '2026-04-10T02:00:00Z',
      },
      {
        id: 'early',
        role: 'assistant',
        content: 'first',
        event_uuid: 'u1',
        created_at: '2026-04-10T01:00:00Z',
      },
    ])

    const { result } = renderHook(() => useCodingAgent('session-sorted'))

    expect(result.current.messages[0].content).toBe('first')
    expect(result.current.messages[1].content).toBe('second')
  })

  test('populates knownEventUuids from cache to prevent duplicates on WS hydration', () => {
    seedCachedMessages('session-dedup', [
      { id: 'msg-1', role: 'assistant', content: 'cached msg', event_uuid: 'known-uuid' },
    ])

    const { result } = renderHook(() => useCodingAgent('session-dedup'))

    // Messages loaded from cache
    expect(result.current.messages).toHaveLength(1)

    // Now simulate an assistant event arriving via WS with same uuid
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'gateway_event',
            event: {
              type: 'assistant',
              uuid: 'known-uuid',
              content: [{ text: 'cached msg' }],
            },
          }),
        }),
      )
    })

    // Should still be 1 message (duplicate was skipped)
    expect(result.current.messages).toHaveLength(1)
  })
})
