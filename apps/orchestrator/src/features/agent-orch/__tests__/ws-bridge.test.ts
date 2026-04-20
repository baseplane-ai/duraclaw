/**
 * Tests for the WS bridge in useCodingAgent.
 *
 * Spec-31 P4b B2: `onStateUpdate` is now a no-op — `SessionState` is no
 * longer the live render source; components derive status/gate from
 * messages via `useDerivedStatus` / `useDerivedGate`. The prop is still
 * registered with `useAgent` so the server push path stays wired until
 * P5 rips it out, but the client no longer writes SessionState into the
 * `sessionLiveStateCollection`.
 *
 * Previous tests in this file asserted that onStateUpdate mirrored
 * status / numTurns etc. into `upsertSessionLiveState` calls. Those
 * assertions are obsolete under P4b — the mirroring is gone. The tests
 * below lock in the new contract: onStateUpdate is registered but
 * performs no live-state writes.
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

// useSessionLiveState owns contextUsage/kataState/sessionResult. Stub
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

// upsertSessionLiveState is observed to prove onStateUpdate does NOT
// write SessionState patches post-P4b. Other call sites (e.g. the
// wsReadyState mirror effect) may still legitimately invoke it.
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

  test('onStateUpdate is still registered on useAgent (prop preserved for P5)', () => {
    renderHook(() => useCodingAgent('test-session'))
    expect(capturedOnStateUpdate).toBeTruthy()
  })

  test('onStateUpdate does not write SessionState into live-state collection (P4b)', () => {
    renderHook(() => useCodingAgent('test-session'))
    const beforeStateWrites = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    ).length

    act(() => {
      capturedOnStateUpdate!({ status: 'running', num_turns: 5 })
    })
    act(() => {
      capturedOnStateUpdate!({ status: 'idle', num_turns: 10 })
    })

    const afterStateWrites = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    ).length

    // Body is a no-op — invoking the handler must not add any `state`
    // patch calls to `upsertSessionLiveState`.
    expect(afterStateWrites).toBe(beforeStateWrites)
  })
})
