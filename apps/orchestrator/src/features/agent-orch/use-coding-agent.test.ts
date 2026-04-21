/**
 * Tests for useCodingAgent hook — SessionMessage wire format handling.
 *
 * @vitest-environment jsdom
 *
 * Validates:
 * - Cache-first hydration from local collection (parts-based CachedMessage)
 * - Unified { type:'messages', seq, payload:{kind:'delta'} } wire format:
 *   upsert, optimistic replacement, cache writes
 * - Unified { type:'messages', seq, payload:{kind:'snapshot'} } wire format:
 *   bulk replay, watermark bump
 * - Gap detection: out-of-order delta → requestSnapshot RPC, stale deltas dropped
 * - Legacy { type:'messages', messages } shape still tolerated for deploy rollover
 * - sendMessage: optimistic insert in SessionMessage format, rollback on failure
 * - injectQaPair: parts-based qa_pair message
 * - Legacy gateway_event: only non-message events processed (kata_state, context_usage, result)
 * - Stripped events (assistant, tool_result, partial_assistant, file_changed) no longer handled
 */

import { getActiveTransaction } from '@tanstack/db'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CachedMessage } from '~/db/messages-collection'

// ── Mock data ────────────────────────────────────────────────────────

// `vi.hoisted` makes these references available to the hoisted `vi.mock`
// factory below. mockInsert registers a pending mutation on the active
// TanStack DB transaction (when one is ambient) so `tx.commit()` doesn't
// short-circuit on mutations.length===0. Real collections do this via
// ambientTransaction.applyMutations() — see @tanstack/db collection/mutations.js.
const mocks = vi.hoisted(() => {
  const cachedMessagesStore = new Map<string, unknown>()
  const collectionSubs = new Set<() => void>()
  const bumpCollection = () => {
    for (const cb of collectionSubs) cb()
  }

  // Forward-decl the collection handle so mockInsert can attach it to
  // mutations registered on the ambient transaction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockCollection: any = {
    id: 'test-messages',
    // _state is what Transaction.touchCollection() pokes at — provide the
    // methods it calls so rollback()/commit() don't explode.
    _state: {
      onTransactionStateChange: () => {},
      pendingSyncedTransactions: [] as unknown[],
      commitPendingTransactions: () => {},
    },
    [Symbol.iterator]: () => cachedMessagesStore.entries(),
    has: (id: string) => cachedMessagesStore.has(id),
    utils: { isFetching: false },
  }

  return { cachedMessagesStore, collectionSubs, bumpCollection, mockCollection }
})

const { cachedMessagesStore, collectionSubs, bumpCollection, mockCollection } = mocks as {
  cachedMessagesStore: Map<string, CachedMessage>
  collectionSubs: Set<() => void>
  bumpCollection: () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCollection: any
}

// ── Mocks ────────────────────────────────────────────────────────────

const mockInsert = vi.fn((msg: CachedMessage) => {
  if (!cachedMessagesStore.has(msg.id)) {
    cachedMessagesStore.set(msg.id, msg)
  }
  const ambient = getActiveTransaction()
  if (ambient) {
    ambient.applyMutations([
      {
        mutationId: `mock-${msg.id}`,
        original: {},
        modified: msg,
        changes: msg,
        globalKey: msg.id,
        key: msg.id,
        metadata: undefined,
        syncMetadata: {},
        optimistic: true,
        type: 'insert',
        createdAt: new Date(),
        updatedAt: new Date(),
        collection: mockCollection,
      },
    ])
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

// Finalise the collection handle with mutation wrappers. Done after
// mockInsert/Update/Delete are defined so they're captured by reference.
// GH#38 P1.3: collection.insert returns a Transaction-like handle with
// `isPersisted.promise` so `await tx.isPersisted.promise` in sendMessage /
// submitDraft can settle. Tests that need to simulate a mutationFn throw
// can call `mockCollection.__rejectNextInsert(err)` before the insert.
let nextInsertRejection: Error | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(mockCollection as any).__rejectNextInsert = (err: Error) => {
  nextInsertRejection = err
}
mockCollection.insert = (...args: unknown[]) => {
  mockInsert(...(args as [CachedMessage]))
  const rejection = nextInsertRejection
  nextInsertRejection = null
  return {
    isPersisted: {
      promise: rejection ? Promise.reject(rejection) : Promise.resolve(),
    },
  }
}
mockCollection.update = (...args: unknown[]) =>
  mockUpdate(...(args as [string, (d: CachedMessage) => void]))
mockCollection.delete = (...args: unknown[]) => mockDelete(...(args as [string | string[]]))

// @tanstack/query-db-collection sync-write API — what the WS handler uses.
// Route through the same mockInsert/mockUpdate/mockDelete tracking so existing
// assertions keep working.
mockCollection.utils.writeUpsert = (data: CachedMessage | CachedMessage[]) => {
  const items = Array.isArray(data) ? data : [data]
  for (const item of items) {
    if (cachedMessagesStore.has(item.id)) {
      mockUpdate(item.id, (draft: CachedMessage) => {
        Object.assign(draft, item)
      })
    } else {
      mockInsert(item)
    }
  }
}
mockCollection.utils.writeInsert = (data: CachedMessage | CachedMessage[]) => {
  const items = Array.isArray(data) ? data : [data]
  for (const item of items) mockInsert(item)
}
mockCollection.utils.writeUpdate = (
  data: Partial<CachedMessage> | Array<Partial<CachedMessage>>,
) => {
  const items = Array.isArray(data) ? data : [data]
  for (const item of items) {
    const id = (item as { id: string }).id
    if (id) mockUpdate(id, (draft: CachedMessage) => Object.assign(draft, item))
  }
}
mockCollection.utils.writeDelete = (keys: string | string[]) => mockDelete(keys)
mockCollection.utils.writeBatch = (callback: () => void) => callback()

vi.mock('~/db/messages-collection', () => {
  // Reference via the vi.hoisted() bundle — `mockCollection` the top-level
  // destructured const is in TDZ at vi.mock hoist time.
  return {
    messagesCollection: mocks.mockCollection,
    createMessagesCollection: () => mocks.mockCollection,
  }
})

// P4: branch-info collection mock — backed by a simple Map so tests can
// seed rows directly and assert on inserts via the snapshot dispatch path.
const branchInfoStore = new Map<
  string,
  {
    parentMsgId: string
    sessionId: string
    siblings: string[]
    activeId: string
    updatedAt: string
  }
>()

vi.mock('~/db/branch-info-collection', () => {
  const coll = {
    has: (key: string) => branchInfoStore.has(key),
    insert: vi.fn((row: { parentMsgId: string }) => {
      // DB-cbb1-0420: Match real TanStack DB Collection.insert semantics —
      // throw on duplicate key so the update-first-insert-fallback path is
      // exercised. Pre-fix tests relied on the mock silently overwriting,
      // which masked the real persisted-collection behavior.
      if (branchInfoStore.has(row.parentMsgId)) {
        throw new Error(`duplicate key: ${row.parentMsgId}`)
      }
      branchInfoStore.set(row.parentMsgId, row as never)
    }),
    update: vi.fn((key: string, patcher: (draft: Record<string, unknown>) => void) => {
      // DB-cbb1-0420: Throw on missing key so the fallback path falls
      // through to insert — mirrors TanStack DB Collection.update semantics.
      const existing = branchInfoStore.get(key)
      if (!existing) throw new Error(`not found: ${key}`)
      const draft = { ...existing }
      patcher(draft as unknown as Record<string, unknown>)
      branchInfoStore.set(key, draft as never)
    }),
    delete: vi.fn((key: string) => {
      branchInfoStore.delete(key)
    }),
    [Symbol.iterator]: () => {
      const entries: Array<[string, unknown]> = []
      for (const [k, v] of branchInfoStore) entries.push([k, v])
      return entries[Symbol.iterator]()
    },
    utils: {},
  }
  return {
    createBranchInfoCollection: () => coll,
  }
})

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
      return { messages: filtered, isLoading: false, isFetching: false }
    },
  }
})

// Spec #37 P2b: session-authoritative state comes from `useSession()` over
// `sessionsCollection`. Back the mock with an in-memory store so tests can
// seed rows and assert that JSON-column writes round-trip through
// `parseJsonField`. `sessionLocalCollection` tracks only `wsReadyState`.
const sessionsStore = new Map<string, Record<string, unknown>>()
const sessionsSubs = new Set<() => void>()
const bumpSessions = () => {
  for (const cb of sessionsSubs) cb()
}

const sessionLocalStore = new Map<string, { id: string; wsReadyState: number }>()

const { mockInvalidateQueries } = vi.hoisted(() => ({
  mockInvalidateQueries: vi.fn(),
}))

vi.mock('~/db/db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { invalidateQueries: mockInvalidateQueries },
}))

vi.mock('~/hooks/use-sessions-collection', async () => {
  const React = await import('react')
  return {
    useSession: (sessionId: string | null | undefined) => {
      const [, setV] = React.useState(0)
      React.useEffect(() => {
        const cb = () => setV((v: number) => v + 1)
        sessionsSubs.add(cb)
        return () => {
          sessionsSubs.delete(cb)
        }
      }, [])
      return sessionId ? sessionsStore.get(sessionId) : undefined
    },
  }
})

vi.mock('~/db/session-local-collection', () => ({
  sessionLocalCollection: {
    insert: vi.fn((row: { id: string; wsReadyState: number }) => {
      if (sessionLocalStore.has(row.id)) {
        throw new Error(`duplicate key: ${row.id}`)
      }
      sessionLocalStore.set(row.id, row)
    }),
    update: vi.fn((key: string, patcher: (draft: { wsReadyState: number }) => void) => {
      const existing = sessionLocalStore.get(key)
      if (!existing) throw new Error(`not found: ${key}`)
      const draft = { ...existing }
      patcher(draft)
      sessionLocalStore.set(key, draft)
    }),
    delete: vi.fn((key: string) => {
      sessionLocalStore.delete(key)
    }),
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
    return {
      call: mockCall,
      readyState: 3,
      // use-coding-agent subscribes to open/close/error on the PartySocket
      // instance to mirror readyState through React state (Spec #31: our
      // SessionDO suppresses protocol messages, so useAgent's internal
      // setState never fires on open and `connection.readyState` stays
      // React-invisible without this event-driven mirror).
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
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
    sessionsStore.clear()
    collectionSubs.clear()
    sessionsSubs.clear()
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
    // Spec #31 P5 B10: `state` is no longer surfaced by useCodingAgent.
    expect(result.current.kataState).toBeNull()
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

  test('resets per-session kataState when agentName changes', () => {
    // Spec #37 P2b: kataState is derived from `session.kataStateJson` via
    // `parseJsonField`. Per-session isolation is still verified by swapping
    // the agentName and asserting the new session's row drives the value.
    const { result, rerender } = renderHook(({ name }: { name: string }) => useCodingAgent(name), {
      initialProps: { name: 'session-a' },
    })

    act(() => {
      sessionsStore.set('session-a', {
        id: 'session-a',
        kataStateJson: JSON.stringify({ currentMode: 'impl' }),
      })
      bumpSessions()
    })

    expect(result.current.kataState).not.toBeNull()
    rerender({ name: 'session-b' })
    expect(result.current.kataState).toBeNull()
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

describe('sendMessage (SessionMessage format)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    sessionsStore.clear()
    collectionSubs.clear()
    sessionsSubs.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('creates optimistic user message with parts format (usr-client-<uuid>)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    act(() => {
      result.current.sendMessage('Test message')
    })

    expect(result.current.messages).toHaveLength(1)
    const msg = result.current.messages[0]
    expect(msg.role).toBe('user')
    expect(msg.parts).toEqual([{ type: 'text', text: 'Test message' }])
    expect(msg.id).toMatch(/^usr-client-/)
    expect(msg.createdAt).toBeInstanceOf(Date)
  })

  test('rollback-on-rpc-failure: sendMessage returns {ok:false} when mutationFn throws (GH#38 P1.3)', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // GH#38 P1.3: string path routes through messagesCollection.insert →
    // factory onInsert. Simulate the mutationFn throwing by rejecting the
    // insert's isPersisted promise.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mockCollection as any).__rejectNextInsert(new Error('session not running'))

    let sendResult: { ok: boolean; error?: string } | undefined
    await act(async () => {
      sendResult = (await result.current.sendMessage('Failing message')) as {
        ok: boolean
        error?: string
      }
    })

    // When the mutationFn throws, TanStack DB rejects isPersisted and rolls
    // back the optimistic row. sendMessage surfaces that as {ok:false,error}.
    expect(sendResult?.ok).toBe(false)
    expect(sendResult?.error).toContain('session not running')
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
    sessionsStore.clear()
    collectionSubs.clear()
    sessionsSubs.clear()
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
    sessionsStore.clear()
    collectionSubs.clear()
    sessionsSubs.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('kata_state events invalidate the sessions query', () => {
    // Spec #37 P2b B16: kata_state is now server-persisted into
    // `agent_sessions.kata_state_json` and broadcast via the synced-collection
    // delta. The client no longer writes it anywhere directly — it just
    // invalidates the queryKey so `queryFn` refetches if/when the cold-start
    // path is in play.
    renderHook(() => useCodingAgent('test-session'))

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

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions'] })
  })

  test('context_usage events invalidate the sessions query', () => {
    // Spec #37 P2b B16: context_usage is server-persisted on agent_sessions
    // (context_usage_json) and reaches the client via the synced delta.
    // The gateway_event handler is just an invalidate-pass-through.
    renderHook(() => useCodingAgent('test-session'))

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

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions'] })
  })

  // Spec #37: `result` gateway_event client handler removed; cost /
  // duration / numTurns and the running → idle transition are all
  // served by the `agent_sessions` synced-collection delta (DO writes
  // via syncResultToD1 + broadcastSessionRow). The prior
  // `processes result events` test is therefore intentionally absent.

  // Spec #37 P2b B16: the legacy per-turn summary frame handler is
  // retired — the DO now broadcasts per-turn state changes as
  // `agent_sessions` synced deltas and the sessionsCollection converges
  // automatically. The prior
  // regression guard for the turn-counter refresh is therefore intentionally
  // absent.

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

describe('branch tracking (RPC fire-and-forget — GH#38 P1.5)', () => {
  // GH#38 P1.5: branchInfo now rides a standalone
  // `{type:'synced-collection-delta', collection:'branchInfo:<id>'}` frame
  // dispatched by the session-stream primitives — the hook no longer
  // pokes `createBranchInfoCollection().insert(...)` on receipt, and the
  // unified `{type:'messages'}` wire (with its embedded branchInfo)
  // is retired. What we still test: (a) the RPC facade forwards
  // correctly, (b) navigateBranch resolves the target sibling via the
  // branch-info collection mock and fires getBranchHistory.

  beforeEach(() => {
    cachedMessagesStore.clear()
    sessionsStore.clear()
    collectionSubs.clear()
    sessionsSubs.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
    mockCall.mockReset()
    mockCall.mockResolvedValue([])
    branchInfoStore.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('resubmitMessage forwards RPC — DO pushes converging synced deltas', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))
    mockCall.mockResolvedValueOnce({ ok: true, leafId: 'usr-5' })

    await act(async () => {
      const res = await result.current.resubmitMessage('usr-1', 'edited')
      expect(res.ok).toBe(true)
      expect(res.leafId).toBe('usr-5')
    })

    expect(mockCall).toHaveBeenCalledWith('resubmitMessage', ['usr-1', 'edited'])
    // No side-channel getMessages RPC — DO-pushed frames converge the view.
    expect(mockCall).not.toHaveBeenCalledWith('getMessages', expect.anything())
  })

  test('resubmitMessage surfaces DO failure result', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))
    mockCall.mockResolvedValueOnce({ ok: false, error: 'Original message not found' })

    await act(async () => {
      const res = await result.current.resubmitMessage('usr-99', 'nope')
      expect(res.ok).toBe(false)
      expect(res.error).toBe('Original message not found')
    })
  })

  test('navigateBranch no-ops when branch-info collection has no matching row', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    await act(async () => {
      await result.current.navigateBranch('usr-1', 'next')
    })

    expect(mockCall).not.toHaveBeenCalledWith('getBranchHistory', expect.anything())
  })

  test('navigateBranch calls getBranchHistory with the target sibling id', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))
    mockCall.mockResolvedValue({ ok: true })

    // Seed the branch-info store directly — the synced-collection factory
    // would populate this path via its internal `write({type:'insert', value})`.
    branchInfoStore.set('msg-0', {
      parentMsgId: 'msg-0',
      sessionId: 'test-session',
      siblings: ['usr-1', 'usr-3'],
      activeId: 'usr-1',
      updatedAt: '2026-04-19T00:00:00Z',
    })

    await act(async () => {
      await result.current.navigateBranch('usr-1', 'next')
    })

    expect(mockCall).toHaveBeenCalledWith('getBranchHistory', ['usr-3'])
  })
})
