/**
 * Tests for the WS bridge in useCodingAgent.
 *
 * Validates that onStateUpdate calls upsertSessionLiveState with the new
 * state payload plus mirrored top-level fields (status, numTurns, model,
 * project, prompt, totalCostUsd, durationMs) so session-list readers can
 * project SessionRecord-shaped rows.
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

// messagesCollection + useMessagesCollection are now used by useCodingAgent
// on every render (live-query render source). Minimal no-op mocks so the
// hook renders in the test environment without needing OPFS / react-db.
vi.mock('~/db/messages-collection', () => {
  const coll = {
    [Symbol.iterator]: () => [][Symbol.iterator](),
    has: () => false,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    utils: { isFetching: false },
  }
  return {
    messagesCollection: coll,
    createMessagesCollection: () => coll,
  }
})

vi.mock('~/hooks/use-messages-collection', () => ({
  useMessagesCollection: () => ({ messages: [], isLoading: false, isFetching: false }),
}))

// useSessionLiveState owns state/contextUsage/kataState/sessionResult. Stub
// it so the hook doesn't subscribe to the real collection across tests.
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

// upsertSessionLiveState is the single write path out of onStateUpdate.
// Capture all calls so we can assert on the payload shape.
const mockUpsert = vi.fn()

vi.mock('~/db/session-live-state-collection', () => ({
  sessionLiveStateCollection: {
    [Symbol.iterator]: () => [][Symbol.iterator](),
    has: () => false,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  upsertSessionLiveState: (...args: unknown[]) => mockUpsert(...args),
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

  test('onStateUpdate calls upsertSessionLiveState with mirrored fields', () => {
    renderHook(() => useCodingAgent('test-session'))

    expect(capturedOnStateUpdate).toBeTruthy()

    act(() => {
      capturedOnStateUpdate!({ status: 'running', num_turns: 5 })
    })

    // Find the onStateUpdate call (there's also a wsReadyState mirror effect).
    const stateCalls = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    )
    expect(stateCalls.length).toBeGreaterThan(0)
    const [agentName, patch] = stateCalls[stateCalls.length - 1]
    expect(agentName).toBe('test-session')
    expect(patch).toMatchObject({
      state: { status: 'running', num_turns: 5 },
      wsReadyState: 1,
      status: 'running',
      numTurns: 5,
    })
  })

  test('onStateUpdate mirrors num_turns when null (kept as-is)', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle', num_turns: null })
    })

    const stateCalls = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    )
    const patch = stateCalls[stateCalls.length - 1][1] as Record<string, unknown>
    expect(patch.status).toBe('idle')
    // Current-state contract: numTurns mirrors newState.num_turns verbatim
    // (including null). Consumers treat null as "unknown" and fall back.
    expect(patch).toHaveProperty('numTurns', null)
  })

  test('onStateUpdate mirrors num_turns when undefined (kept as-is)', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedOnStateUpdate!({ status: 'running' })
    })

    const stateCalls = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    )
    const patch = stateCalls[stateCalls.length - 1][1] as Record<string, unknown>
    expect(patch.status).toBe('running')
    expect(patch).toHaveProperty('numTurns', undefined)
  })

  test('uses agentName as the live-state key', () => {
    renderHook(() => useCodingAgent('my-specific-agent'))

    act(() => {
      capturedOnStateUpdate!({ status: 'idle' })
    })

    const stateCalls = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    )
    expect(stateCalls.length).toBeGreaterThan(0)
    const [agentName, patch] = stateCalls[stateCalls.length - 1]
    expect(agentName).toBe('my-specific-agent')
    expect((patch as Record<string, unknown>).status).toBe('idle')
  })

  test('upserts live state on every state change', () => {
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

    const stateCalls = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    )
    expect(stateCalls.length).toBe(3)
  })
})
