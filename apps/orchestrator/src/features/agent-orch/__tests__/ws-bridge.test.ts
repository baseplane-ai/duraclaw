/**
 * Tests for the WS bridge in useCodingAgent.
 *
 * Validates that onStateUpdate calls sessionsCollection.update
 * with the correct status, updated_at, and num_turns fields.
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

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: {
    update: (...args: unknown[]) => mockCollectionUpdate(...args),
  },
}))

// Import after mocks
import { act, renderHook } from '@testing-library/react'
import { useCodingAgent } from '../use-coding-agent'

describe('WS bridge in useCodingAgent', () => {
  beforeEach(() => {
    capturedOnStateUpdate = null
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('onStateUpdate calls sessionsCollection.update with status and updated_at', () => {
    renderHook(() => useCodingAgent('test-session'))

    expect(capturedOnStateUpdate).toBeTruthy()

    const now = new Date('2026-04-13T12:00:00Z')
    vi.setSystemTime(now)

    act(() => {
      capturedOnStateUpdate!({ status: 'running', num_turns: 5 })
    })

    expect(mockCollectionUpdate).toHaveBeenCalledWith('test-session', expect.any(Function))

    // Execute the draft updater to verify its behavior
    const draft: Record<string, unknown> = { status: 'idle', updated_at: '', num_turns: 0 }
    const updater = mockCollectionUpdate.mock.calls[0][1] as (d: Record<string, unknown>) => void
    updater(draft)

    expect(draft.status).toBe('running')
    expect(draft.updated_at).toBe('2026-04-13T12:00:00.000Z')
    expect(draft.num_turns).toBe(5)
  })

  test('onStateUpdate skips num_turns when null', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle', num_turns: null })
    })

    const draft: Record<string, unknown> = { status: 'running', updated_at: '', num_turns: 3 }
    const updater = mockCollectionUpdate.mock.calls[0][1] as (d: Record<string, unknown>) => void
    updater(draft)

    expect(draft.status).toBe('idle')
    // num_turns should not be updated when null
    expect(draft.num_turns).toBe(3)
  })

  test('onStateUpdate skips num_turns when undefined', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'running' })
    })

    const draft: Record<string, unknown> = { status: 'idle', updated_at: '', num_turns: 7 }
    const updater = mockCollectionUpdate.mock.calls[0][1] as (d: Record<string, unknown>) => void
    updater(draft)

    expect(draft.num_turns).toBe(7)
  })

  test('onStateUpdate catches errors when collection item does not exist', () => {
    mockCollectionUpdate.mockImplementation(() => {
      throw new Error('Item not found')
    })

    renderHook(() => useCodingAgent('nonexistent-session'))

    // Should not throw
    expect(() => {
      act(() => {
        capturedOnStateUpdate!({ status: 'running', num_turns: 1 })
      })
    }).not.toThrow()
  })

  test('uses agentName as the collection key', () => {
    renderHook(() => useCodingAgent('my-specific-agent'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    expect(mockCollectionUpdate).toHaveBeenCalledWith('my-specific-agent', expect.any(Function))
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
