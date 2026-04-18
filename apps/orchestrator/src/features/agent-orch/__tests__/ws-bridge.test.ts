/**
 * Tests for the WS bridge in useCodingAgent.
 *
 * Validates that onStateUpdate calls sessionsCollection.update
 * with the correct status, updatedAt, and numTurns fields.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ── Capture the onStateUpdate callback from useAgent ──────────────────

let capturedOnStateUpdate: ((state: Record<string, unknown>) => void) | null = null

vi.mock('agents/react', () => ({
  useAgent: (opts: {
    onStateUpdate?: (state: Record<string, unknown>) => void
    onMessage?: (msg: MessageEvent) => void
  }) => {
    capturedOnStateUpdate = opts.onStateUpdate ?? null
    return {
      call: vi.fn().mockResolvedValue([]),
    }
  },
}))

const mockCollectionUpdate = vi.fn()
const mockCollectionHas = vi.fn().mockReturnValue(true)

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: {
    // New production code writes through utils.writeUpdate (the
    // queryCollectionOptions doesn't expose a direct .update API); keep
    // the legacy `update` spy as an alias so existing assertions still work.
    utils: { writeUpdate: (...args: unknown[]) => mockCollectionUpdate(...args) },
    update: (...args: unknown[]) => mockCollectionUpdate(...args),
    has: (...args: unknown[]) => mockCollectionHas(...args),
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

  test('onStateUpdate calls sessionsCollection.utils.writeUpdate with status and updated_at', () => {
    renderHook(() => useCodingAgent('test-session'))

    expect(capturedOnStateUpdate).toBeTruthy()

    const now = new Date('2026-04-13T12:00:00Z')
    vi.setSystemTime(now)

    act(() => {
      capturedOnStateUpdate!({ status: 'running', num_turns: 5 })
    })

    // Production code passes a single patch object to utils.writeUpdate.
    expect(mockCollectionUpdate).toHaveBeenCalledWith(
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

    const patch = mockCollectionUpdate.mock.calls[0][0] as Record<string, unknown>
    expect(patch.status).toBe('idle')
    // numTurns should NOT be present on the patch when num_turns is null
    expect('numTurns' in patch).toBe(false)
  })

  test('onStateUpdate skips num_turns when undefined', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'running' })
    })

    const patch = mockCollectionUpdate.mock.calls[0][0] as Record<string, unknown>
    expect('numTurns' in patch).toBe(false)
  })

  test('onStateUpdate skips update when collection item does not exist', () => {
    mockCollectionHas.mockReturnValue(false)

    renderHook(() => useCodingAgent('nonexistent-session'))

    expect(() => {
      act(() => {
        capturedOnStateUpdate!({ status: 'running', num_turns: 1 })
      })
    }).not.toThrow()

    expect(mockCollectionUpdate).not.toHaveBeenCalled()
  })

  test('uses agentName as the collection key', () => {
    renderHook(() => useCodingAgent('my-specific-agent'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    expect(mockCollectionUpdate).toHaveBeenCalledWith(
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

    expect(mockCollectionUpdate).toHaveBeenCalledTimes(3)
  })
})
