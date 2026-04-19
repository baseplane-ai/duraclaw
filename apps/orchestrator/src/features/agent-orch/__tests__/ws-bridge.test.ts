/**
 * Tests for the WS bridge in useCodingAgent.
 *
 * Validates that onStateUpdate calls sessionsCollection.utils.writeUpdate
 * with the correct status, updatedAt, and numTurns fields.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Capture the onStateUpdate callback so tests can invoke it directly
let capturedOnStateUpdate: ((state: unknown) => void) | null = null

vi.mock('agents/react', () => ({
  useAgent: (_opts: { agent: string; name: string; onStateUpdate?: (s: unknown) => void }) => {
    capturedOnStateUpdate = _opts.onStateUpdate ?? null
    return {
      call: vi.fn().mockResolvedValue([]),
    }
  },
}))

const mockCollectionHas = vi.fn().mockReturnValue(true)
const mockWriteUpdate = vi.fn()

vi.mock('~/db/agent-sessions-collection', () => ({
  agentSessionsCollection: {
    update: vi.fn(),
    has: (...args: unknown[]) => mockCollectionHas(...args),
    utils: { writeUpdate: (...args: unknown[]) => mockWriteUpdate(...args) },
  },
}))

// messagesCollection + useMessagesCollection are now used by useCodingAgent
// on every render (live-query render source). Minimal no-op mocks so the
// hook renders in the test environment without needing OPFS / react-db.
vi.mock('~/db/messages-collection', () => ({
  messagesCollection: {
    [Symbol.iterator]: () => [][Symbol.iterator](),
    has: () => false,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('~/hooks/use-messages-collection', () => ({
  useMessagesCollection: () => ({ messages: [], isLoading: false }),
}))

// useSessionLiveState now owns state/contextUsage/kataState/sessionResult.
// Stub it out so the hook doesn't subscribe to the real live-state collection
// across tests (prior tests' row inserts would otherwise re-render stale
// mounts and re-capture `capturedOnStateUpdate` with the wrong agentName).
vi.mock('~/hooks/use-session-live-state', () => ({
  useSessionLiveState: () => ({
    state: null,
    contextUsage: null,
    kataState: null,
    worktreeInfo: null,
    sessionResult: null,
    wsReadyState: null,
    isLive: false,
  }),
}))

// The real collection module lazily initialises OPFS at import time; keep it
// out of the ws-bridge tests to avoid unrelated re-render churn.
vi.mock('~/db/session-live-state-collection', () => ({
  sessionLiveStateCollection: {
    [Symbol.iterator]: () => [][Symbol.iterator](),
    has: () => false,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  upsertSessionLiveState: vi.fn(),
}))

// Import after mocks
import { act, renderHook } from '@testing-library/react'
import { useCodingAgent } from '../use-coding-agent'

describe('WS bridge in useCodingAgent', () => {
  beforeEach(() => {
    capturedOnStateUpdate = null
    vi.clearAllMocks()
    mockCollectionHas.mockReturnValue(true)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('onStateUpdate calls sessionsCollection.utils.writeUpdate with patch', () => {
    renderHook(() => useCodingAgent('test-session'))

    expect(capturedOnStateUpdate).toBeTruthy()

    const now = new Date('2026-04-13T12:00:00Z')
    vi.setSystemTime(now)

    act(() => {
      capturedOnStateUpdate!({ status: 'running', num_turns: 5 })
    })

    expect(mockWriteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'test-session',
        status: 'running',
        updatedAt: '2026-04-13T12:00:00.000Z',
        numTurns: 5,
      }),
    )
  })

  test('onStateUpdate skips num_turns when null', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle', num_turns: null })
    })

    const patch = mockWriteUpdate.mock.calls[0][0] as Record<string, unknown>
    expect(patch.status).toBe('idle')
    // num_turns null → not included in patch
    expect(patch).not.toHaveProperty('numTurns')
  })

  test('onStateUpdate skips num_turns when undefined', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'running' })
    })

    const patch = mockWriteUpdate.mock.calls[0][0] as Record<string, unknown>
    expect(patch).not.toHaveProperty('numTurns')
  })

  test('onStateUpdate skips update when collection item does not exist', () => {
    mockCollectionHas.mockReturnValue(false)

    renderHook(() => useCodingAgent('nonexistent-session'))

    expect(() => {
      act(() => {
        capturedOnStateUpdate!({ status: 'running', num_turns: 1 })
      })
    }).not.toThrow()

    expect(mockWriteUpdate).not.toHaveBeenCalled()
  })

  test('uses agentName as the collection key', () => {
    renderHook(() => useCodingAgent('my-specific-agent'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    expect(mockWriteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'my-specific-agent', status: 'idle' }),
    )
  })

  test('updates collection on every state change', () => {
    renderHook(() => useCodingAgent('session-1'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })
    act(() => {
      capturedOnStateUpdate!({ status: 'running', num_turns: 1 })
    })
    act(() => {
      capturedOnStateUpdate!({ status: 'idle', num_turns: 10 })
    })

    expect(mockWriteUpdate).toHaveBeenCalledTimes(3)
  })
})
