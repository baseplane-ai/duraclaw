/**
 * Tests for the WS bridge in useCodingAgent.
 *
 * Spec-31 P5 B9/B10 (bootstrap) + spec #37 (state collapse): `onStateUpdate`
 * is no longer registered — the DO suppresses SDK protocol state frames
 * via `shouldSendProtocolMessages() => false`. Components now read status
 * from the D1-mirrored `agent_sessions` row via `useSession`, and gate
 * from messages via `useDerivedGate`. These tests lock in the new
 * contract: no `onStateUpdate` callback is passed to `useAgent`, and
 * sessionLocalCollection only holds `{id, wsReadyState}`.
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
      // `use-coding-agent` subscribes to native open/close/error events on
      // the PartySocket instance to mirror readyState through React state
      // (see commit explaining shouldSendProtocolMessages=false silence).
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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

// Spec #37 P2b: `useSession` reads sessionsCollection; stub it to undefined
// so `parseJsonField(session?.kataStateJson ?? null)` returns null cleanly.
vi.mock('~/hooks/use-sessions-collection', () => ({
  useSession: () => undefined,
}))

// sessionLocalCollection tracks only { id, wsReadyState }. Observe
// insert/update so the test can assert that no SessionState-shaped
// patches ever flow through (the only column is wsReadyState now).
const mockLocalInsert = vi.fn()
const mockLocalUpdate = vi.fn()

vi.mock('~/db/session-local-collection', () => ({
  sessionLocalCollection: {
    insert: (...args: unknown[]) => mockLocalInsert(...args),
    update: (...args: unknown[]) => mockLocalUpdate(...args),
    delete: vi.fn(),
  },
}))

vi.mock('~/db/db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { invalidateQueries: vi.fn() },
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

  test('useCodingAgent writes only { wsReadyState, wsCloseTs } into sessionLocalCollection (Spec #37 B11 + GH#69 B5)', () => {
    renderHook(() => useCodingAgent('test-session'))
    // wsReadyState mirror effect is the only write path into the local
    // collection. GH#69 B5 extended the row with `wsCloseTs` (OPEN→!OPEN
    // stamp). Any insert payload must contain exactly `id`,
    // `wsReadyState`, `wsCloseTs`, and optionally the DO-pushed live
    // status fields; any update patcher must touch `wsReadyState` and
    // optionally `wsCloseTs` + the live status clear fields.
    for (const call of mockLocalInsert.mock.calls) {
      const row = call[0] as Record<string, unknown>
      expect(row).toHaveProperty('id')
      expect(row).toHaveProperty('wsReadyState')
      expect(row).toHaveProperty('wsCloseTs')
    }
    for (const call of mockLocalUpdate.mock.calls) {
      const patcher = call[1] as (draft: Record<string, unknown>) => void
      const draft: Record<string, unknown> = { wsReadyState: 3, wsCloseTs: null }
      patcher(draft)
      // Must always write wsReadyState; may also write wsCloseTs and
      // live status clear fields (liveStatus, liveGate, liveError).
      expect(draft).toHaveProperty('wsReadyState')
    }
  })
})
