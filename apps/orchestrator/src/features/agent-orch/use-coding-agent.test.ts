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
mockCollection.insert = (...args: unknown[]) => mockInsert(...(args as [CachedMessage]))
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
      branchInfoStore.set(row.parentMsgId, row as never)
    }),
    update: vi.fn((key: string, patcher: (draft: Record<string, unknown>) => void) => {
      const existing = branchInfoStore.get(key)
      if (!existing) return
      const draft = { ...existing }
      patcher(draft as unknown as Record<string, unknown>)
      branchInfoStore.set(key, draft as never)
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

// useSessionLiveState + upsertSessionLiveState are the new ingress/egress for
// server-authoritative state. Mock them together with a shared in-memory map
// so onStateUpdate / onMessage writes round-trip back through the hook and
// tests can assert on result.current.state / kataState / etc.
const liveStateStore = new Map<string, Record<string, unknown>>()
const liveStateSubs = new Set<() => void>()
const bumpLiveState = () => {
  for (const cb of liveStateSubs) cb()
}

vi.mock('~/hooks/use-session-live-state', async () => {
  const React = await import('react')
  return {
    useSessionLiveState: (sessionId: string | null | undefined) => {
      const [, setV] = React.useState(0)
      React.useEffect(() => {
        const cb = () => setV((v: number) => v + 1)
        liveStateSubs.add(cb)
        return () => {
          liveStateSubs.delete(cb)
        }
      }, [])
      const row = sessionId ? liveStateStore.get(sessionId) : undefined
      return {
        state: (row?.state as unknown) ?? null,
        contextUsage: (row?.contextUsage as unknown) ?? null,
        kataState: (row?.kataState as unknown) ?? null,
        worktreeInfo: (row?.worktreeInfo as unknown) ?? null,
        sessionResult: (row?.sessionResult as unknown) ?? null,
        wsReadyState: (row?.wsReadyState as number | undefined) ?? null,
        isLive: row?.wsReadyState === 1,
      }
    },
  }
})

vi.mock('~/db/session-live-state-collection', () => ({
  sessionLiveStateCollection: {
    [Symbol.iterator]: () => [][Symbol.iterator](),
    has: () => false,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  upsertSessionLiveState: (sessionId: string, patch: Record<string, unknown>) => {
    const existing = liveStateStore.get(sessionId) ?? {}
    liveStateStore.set(sessionId, { ...existing, ...patch })
    bumpLiveState()
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

// ── MessagesFrame helpers (P1/1b — unified shape) ────────────────────

/**
 * Per-test seq counter for building unified `{type:'messages'}` delta
 * frames. Tests that expect a contiguous delta stream should reset this
 * in `beforeEach` via `msgSeq = 0`.
 */
let msgSeq = 0

function deltaFrame(
  upsert: Array<Record<string, unknown>>,
  opts: { remove?: string[]; sessionId?: string } = {},
) {
  msgSeq += 1
  return {
    type: 'messages',
    sessionId: opts.sessionId ?? 'test-session',
    seq: msgSeq,
    payload: { kind: 'delta', upsert, ...(opts.remove ? { remove: opts.remove } : {}) },
  }
}

function snapshotFrame(
  messages: Array<Record<string, unknown>>,
  opts: { version?: number; sessionId?: string; reason?: string } = {},
) {
  const version = opts.version ?? msgSeq
  return {
    type: 'messages',
    sessionId: opts.sessionId ?? 'test-session',
    seq: version,
    payload: {
      kind: 'snapshot',
      version,
      messages,
      reason: opts.reason ?? 'reconnect',
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('useCodingAgent cache-first hydration', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
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

describe('type: "messages" delta wire format (unified)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
    capturedUseAgentConfig = null
    msgSeq = 0
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('appends a new assistant message', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([
            {
              id: 'asst-1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hello!' }],
            },
          ]),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('asst-1')
    expect(result.current.messages[0].role).toBe('assistant')
    expect(result.current.messages[0].parts[0].text).toBe('Hello!')
  })

  test('upserts an existing assistant message by id (streaming update)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // First message
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([
            {
              id: 'asst-1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hel', state: 'streaming' }],
            },
          ]),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].parts[0].text).toBe('Hel')
    expect(result.current.messages[0].parts[0].state).toBe('streaming')

    // Update same message
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([
            {
              id: 'asst-1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hello world!', state: 'done' }],
            },
          ]),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].parts[0].text).toBe('Hello world!')
    expect(result.current.messages[0].parts[0].state).toBe('done')
  })

  test('inserts optimistic user row with usr-client-<uuid> id (GH#14 P3)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true })

    // Send a message (creates optimistic insert via createTransaction)
    act(() => {
      result.current.sendMessage('Hello agent')
    })

    // The optimistic row is keyed on a client-minted id. The server echo
    // will arrive carrying the SAME id (DO accepts client_message_id), so
    // reconciliation is by id match — no delete+insert churn.
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toMatch(/^usr-client-/)
    expect(result.current.messages[0].parts[0].text).toBe('Hello agent')

    // Verify the RPC carried the client_message_id so the DO can use it as
    // the primary id when it persists and echoes the user turn.
    const sendCall = mockCall.mock.calls.find((c) => c[0] === 'sendMessage')
    expect(sendCall).toBeDefined()
    const opts = sendCall?.[1][1] as { client_message_id?: string } | undefined
    expect(opts?.client_message_id).toMatch(/^usr-client-/)
  })

  test('on rapid double-send, server echoes reconcile only by client_message_id match (GH#14 P3)', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValue({ ok: true })

    // Send A, then B. Each createTransaction mints a unique
    // `usr-client-<uuid>` id; no clearOldest-on-echo race.
    act(() => {
      result.current.sendMessage('A')
    })
    act(() => {
      result.current.sendMessage('B')
    })

    expect(result.current.messages).toHaveLength(2)
    const optimisticA = result.current.messages[0].id
    const optimisticB = result.current.messages[1].id
    expect(optimisticA).toMatch(/^usr-client-/)
    expect(optimisticB).toMatch(/^usr-client-/)
    expect(optimisticA).not.toBe(optimisticB)

    // Server echoes A carrying A's client id back — upsert is idempotent
    // by id so only A's row updates. B's optimistic row is untouched.
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([
            {
              id: optimisticA,
              role: 'user',
              parts: [{ type: 'text', text: 'A' }],
              canonical_turn_id: 'usr-1',
            },
          ]),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    const ids = result.current.messages.map((m) => m.id)
    expect(ids).toContain(optimisticA)
    expect(ids).toContain(optimisticB)
  })

  test('appends multiple messages in sequence', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([{ id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }]),
        ),
      )
    })

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([
            {
              id: 'asst-1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hello!' }],
            },
          ]),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].role).toBe('user')
    expect(result.current.messages[1].role).toBe('assistant')
  })

  test('writes to cache on each delta frame', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([
            {
              id: 'msg-cache-1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'cached' }],
              createdAt: '2026-04-14T00:00:00Z',
            },
          ]),
        ),
      )
    })

    // Check that cacheMessage was called (insert on messagesCollection)
    expect(cachedMessagesStore.has('msg-cache-1')).toBe(true)
    const cached = cachedMessagesStore.get('msg-cache-1')!
    expect(cached.sessionId).toBe('test-session')
    expect(cached.role).toBe('assistant')
    expect(cached.parts[0].text).toBe('cached')
  })
})

describe('type: "messages" snapshot wire format (bulk replay)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
    capturedUseAgentConfig = null
    msgSeq = 0
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('replaces all messages with snapshot frame', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Add a message first via delta
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([{ id: 'old-1', role: 'user', parts: [{ type: 'text', text: 'old' }] }]),
        ),
      )
    })
    expect(result.current.messages).toHaveLength(1)

    // Snapshot replaces everything
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          snapshotFrame(
            [
              { id: 'replay-1', role: 'user', parts: [{ type: 'text', text: 'replayed user' }] },
              {
                id: 'replay-2',
                role: 'assistant',
                parts: [{ type: 'text', text: 'replayed assistant' }],
              },
            ],
            { version: 10 },
          ),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0].id).toBe('replay-1')
    expect(result.current.messages[1].id).toBe('replay-2')
  })

  test('caches all snapshotted messages', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          snapshotFrame(
            [
              { id: 'r-1', role: 'user', parts: [{ type: 'text', text: 'u' }] },
              { id: 'r-2', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
            ],
            { version: 5 },
          ),
        ),
      )
    })

    expect(cachedMessagesStore.has('r-1')).toBe(true)
    expect(cachedMessagesStore.has('r-2')).toBe(true)
  })

  test('delta after snapshot bumps watermark correctly (seq max)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Snapshot advances watermark to version=3
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          snapshotFrame([{ id: 'r-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], {
            version: 3,
          }),
        ),
      )
    })
    msgSeq = 3

    // A delta with seq=4 is contiguous and should apply.
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([
            {
              id: 'asst-new',
              role: 'assistant',
              parts: [{ type: 'text', text: 'hello' }],
            },
          ]),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[1].id).toBe('asst-new')
  })

  test('legacy {type:"messages", messages} shape still hydrates (deploy rollover)', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          messages: [
            { id: 'legacy-1', role: 'user', parts: [{ type: 'text', text: 'u' }] },
            { id: 'legacy-2', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
          ],
        }),
      )
    })

    expect(result.current.messages).toHaveLength(2)
    expect(cachedMessagesStore.has('legacy-1')).toBe(true)
    expect(cachedMessagesStore.has('legacy-2')).toBe(true)
  })
})

describe('MessagesFrame gap detection (P1 B3)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
    capturedUseAgentConfig = null
    msgSeq = 0
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('out-of-order delta triggers requestSnapshot RPC and does NOT apply', () => {
    mockCall.mockResolvedValue(undefined)
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Apply seq=1 normally
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([{ id: 'm-1', role: 'user', parts: [{ type: 'text', text: 'a' }] }]),
        ),
      )
    })
    expect(result.current.messages).toHaveLength(1)

    // Skip seq=2, deliver seq=3 (gap) — should be dropped and requestSnapshot called.
    msgSeq = 2 // account for the "missing" delta
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          deltaFrame([{ id: 'm-3', role: 'assistant', parts: [{ type: 'text', text: 'c' }] }]),
        ),
      )
    })

    expect(result.current.messages).toHaveLength(1) // m-3 not applied
    expect(mockCall).toHaveBeenCalledWith('requestSnapshot', [])
  })

  test('stale delta (seq <= lastSeq) is dropped silently', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Snapshot bumps watermark to 10
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          snapshotFrame([{ id: 's-1', role: 'user', parts: [{ type: 'text', text: 'snap' }] }], {
            version: 10,
          }),
        ),
      )
    })

    // A stale in-flight delta with seq=5 arrives after the snapshot. Must be dropped.
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          sessionId: 'test-session',
          seq: 5,
          payload: {
            kind: 'delta',
            upsert: [{ id: 'stale-1', role: 'assistant', parts: [{ type: 'text', text: 'x' }] }],
          },
        }),
      )
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('s-1')
  })

  test('delta remove list deletes rows', () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    // Seed two messages via a snapshot
    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          snapshotFrame(
            [
              { id: 'keep-1', role: 'user', parts: [{ type: 'text', text: 'keep' }] },
              { id: 'drop-1', role: 'assistant', parts: [{ type: 'text', text: 'drop' }] },
            ],
            { version: 2 },
          ),
        ),
      )
    })
    msgSeq = 2

    // Delta with remove only
    act(() => {
      capturedUseAgentConfig?.onMessage?.(makeWsMessage(deltaFrame([], { remove: ['drop-1'] })))
    })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].id).toBe('keep-1')
  })
})

describe('sendMessage (SessionMessage format)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
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

  test('rollback-on-rpc-failure: sendMessage returns {ok:false} when RPC rejects (GH#14 P3 B5)', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: false, error: 'session not running' })

    let sendResult: { ok: boolean; error?: string } | undefined
    await act(async () => {
      sendResult = (await result.current.sendMessage('Failing message')) as {
        ok: boolean
        error?: string
      }
    })

    // createTransaction rejects its isPersisted promise when the mutationFn
    // throws; sendMessage surfaces that as {ok:false,error}. The optimistic
    // row reconciles via the collection's transaction-aware reactive state
    // (in production TanStack DB wires touchCollection() into the backing
    // collection; here we assert the public contract).
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
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
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
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
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

describe('branch tracking (P4)', () => {
  beforeEach(() => {
    cachedMessagesStore.clear()
    liveStateStore.clear()
    collectionSubs.clear()
    liveStateSubs.clear()
    capturedUseAgentConfig = null
    vi.clearAllMocks()
    branchInfoStore.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('resubmitMessage forwards RPC call — DO-authored snapshot converges the view', async () => {
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValueOnce({ ok: true, leafId: 'usr-5' })

    await act(async () => {
      const res = await result.current.resubmitMessage('usr-1', 'edited')
      expect(res.ok).toBe(true)
      expect(res.leafId).toBe('usr-5')
    })

    expect(mockCall).toHaveBeenCalledWith('resubmitMessage', ['usr-1', 'edited'])
    // P4: no side-channel getMessages RPC — the DO pushes the new view
    // via its own snapshot frame.
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

    // No RPC call — row missing.
    expect(mockCall).not.toHaveBeenCalledWith('getBranchHistory', expect.anything())
  })

  test('navigateBranch calls getBranchHistory with the target sibling id', async () => {
    // Seed the branch-info collection via a snapshot frame carrying
    // branchInfo (this is the DO → client B7 path).
    const { result } = renderHook(() => useCodingAgent('test-session'))

    mockCall.mockResolvedValue({ ok: true })

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage(
          snapshotFrame([{ id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'v1' }] }], {
            version: 1,
            reason: 'reconnect',
          }),
        ),
      )
    })

    // Manually inject the branchInfo row into the mock collection — the
    // snapshot path upserts via createBranchInfoCollection().insert.
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

  test('snapshot payload branchInfo rows land in the branch-info collection', () => {
    renderHook(() => useCodingAgent('test-session'))

    act(() => {
      capturedUseAgentConfig?.onMessage?.(
        makeWsMessage({
          type: 'messages',
          sessionId: 'test-session',
          seq: 1,
          payload: {
            kind: 'snapshot',
            version: 1,
            reason: 'reconnect',
            messages: [{ id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'v1' }] }],
            branchInfo: [
              {
                parentMsgId: 'msg-0',
                sessionId: 'test-session',
                siblings: ['usr-1', 'usr-3'],
                activeId: 'usr-1',
                updatedAt: '2026-04-19T00:00:00Z',
              },
            ],
          },
        }),
      )
    })

    expect(branchInfoStore.has('msg-0')).toBe(true)
    const row = branchInfoStore.get('msg-0')!
    expect(row.siblings).toEqual(['usr-1', 'usr-3'])
    expect(row.activeId).toBe('usr-1')
  })
})
