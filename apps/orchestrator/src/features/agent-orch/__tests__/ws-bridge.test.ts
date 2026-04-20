/**
 * Tests for the WS bridge in useCodingAgent.
 *
 * Spec-31 P5 B9/B10: `onStateUpdate` is no longer registered — the DO
 * suppresses SDK protocol state frames via
 * `shouldSendProtocolMessages() => false`. `SessionState` is deleted;
 * components derive status/gate from messages via `useDerivedStatus` /
 * `useDerivedGate`. These tests lock in the new contract: no
 * `onStateUpdate` callback is passed to `useAgent`, and no SessionState
 * patches are ever written into the live-state collection.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Capture the onStateUpdate option (if any) passed to useAgent.
let capturedOnStateUpdate: ((state: unknown) => void) | null | undefined = null

vi.mock('agents/react', () => ({
  useAgent: (_opts: { agent: string; name: string; onStateUpdate?: (s: unknown) => void }) => {
    capturedOnStateUpdate = _opts.onStateUpdate
    return {
      call: vi.fn().mockResolvedValue([]),
      readyState: 3,
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

// useSessionLiveState owns contextUsage/kataState/worktreeInfo. Stub
// it so the hook doesn't subscribe to the real collection across tests.
vi.mock('~/hooks/use-session-live-state', () => ({
  useSessionLiveState: () => ({
    contextUsage: null,
    kataState: null,
    worktreeInfo: null,
    wsReadyState: null,
    isLive: false,
  }),
}))

// upsertSessionLiveState is observed to prove the hook never writes
// SessionState-shaped patches into the collection (P5 B10).
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
import { renderHook } from '@testing-library/react'
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

  test('onStateUpdate is NOT registered on useAgent (P5 B9)', () => {
    // Spec #31 P5 B9: the DO suppresses SDK state broadcast; the client
    // no longer supplies an `onStateUpdate` handler because the frame
    // shape (`SessionState`) is deleted.
    renderHook(() => useCodingAgent('test-session'))
    expect(capturedOnStateUpdate).toBeUndefined()
  })

  test('useCodingAgent never writes SessionState-shaped patches into live-state collection (P5 B10)', () => {
    renderHook(() => useCodingAgent('test-session'))
    // wsReadyState mirror effect legitimately upserts, but no call should
    // carry a `state` field (the field is gone from the narrowed
    // SessionLiveState).
    const stateWrites = mockUpsert.mock.calls.filter(
      (c) => (c[1] as { state?: unknown }).state !== undefined,
    )
    expect(stateWrites.length).toBe(0)
  })
})
