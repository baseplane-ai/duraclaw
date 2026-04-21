/**
 * @vitest-environment jsdom
 *
 * Unit tests for the per-sessionId messages-collection factory (GH#38 P1.3).
 *
 * Strategy: mock `createSyncedCollection` so we observe the exact options
 * the factory is given — subscribe / onReconnect registrars, queryFn with
 * cursor contract, onInsert mutationFn, schemaVersion. Also tests that a
 * delta frame routed through the injected subscribe ends up as a row in
 * the collection via a fake `createSyncedCollection` that wires
 * begin/write/commit through a local Map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Captured config for each createSyncedCollection() invocation.
interface CapturedConfig {
  id: string
  collection?: string
  queryKey: readonly unknown[]
  getKey: (row: { id: string }) => string
  subscribe: (
    handler: (frame: {
      type: 'synced-collection-delta'
      collection: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ops: any[]
    }) => void,
  ) => () => void
  onReconnect?: (handler: () => void) => () => void
  queryFn: () => Promise<unknown[]>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onInsert?: (ctx: { transaction: { mutations: Array<{ modified: any }> } }) => Promise<unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  persistence?: any
  schemaVersion?: number
}

// Backing store for the fake collection so integration-y assertions can
// read rows the delta frame produced.
const store = new Map<string, Record<string, unknown>>()
const capturedConfigs: CapturedConfig[] = []

const mockCreateSyncedCollection = vi.fn((config: CapturedConfig) => {
  capturedConfigs.push(config)
  // Wire the subscribe handler through a minimal begin/write/commit that
  // writes into `store` by getKey so tests can assert on the factory's
  // end-to-end wire.
  config.subscribe((frame) => {
    if (frame.collection !== config.collection) return
    for (const op of frame.ops) {
      if (op.type === 'delete') store.delete(op.key as string)
      else store.set(config.getKey(op.value), op.value)
    }
  })
  return {
    [Symbol.iterator]: () => store.entries(),
    delete: vi.fn((keys: string | string[]) => {
      const ids = Array.isArray(keys) ? keys : [keys]
      for (const id of ids) store.delete(id)
    }),
    insert: vi.fn(),
    utils: {},
    __config: config,
  }
})

vi.mock('./synced-collection', () => ({
  createSyncedCollection: mockCreateSyncedCollection,
}))

vi.mock('./db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { fetchQuery: vi.fn() },
}))

// Mock the session-stream primitives so we can drive frames from the test.
const frameHandlers = new Map<
  string,
  Set<(frame: { type: 'synced-collection-delta'; collection: string; ops: unknown[] }) => void>
>()
const reconnectHandlers = new Map<string, Set<() => void>>()

vi.mock('~/features/agent-orch/use-coding-agent', () => ({
  subscribeSessionStream: vi.fn((sessionId: string, handler: never) => {
    let set = frameHandlers.get(sessionId)
    if (!set) {
      set = new Set()
      frameHandlers.set(sessionId, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }),
  onSessionStreamReconnect: vi.fn((sessionId: string, handler: () => void) => {
    let set = reconnectHandlers.get(sessionId)
    if (!set) {
      set = new Set()
      reconnectHandlers.set(sessionId, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }),
}))

describe('messages-collection factory (GH#38 P1.3)', () => {
  beforeEach(() => {
    store.clear()
    capturedConfigs.length = 0
    frameHandlers.clear()
    reconnectHandlers.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports createMessagesCollection factory and legacy singleton', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    expect(mod.createMessagesCollection).toBeDefined()
    expect(typeof mod.createMessagesCollection).toBe('function')
    expect(mod.messagesCollection).toBeDefined()
  })

  it('passes id, collection name, queryKey, getKey, schemaVersion 6 to createSyncedCollection', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    mod.createMessagesCollection('sess-1')

    const cfg = capturedConfigs.find((c) => c.id === 'messages:sess-1')
    expect(cfg).toBeDefined()
    expect(cfg!.collection).toBe('messages:sess-1')
    expect(cfg!.queryKey).toEqual(['messages', 'sess-1'])
    expect(cfg!.getKey({ id: 'msg-123' })).toBe('msg-123')
    expect(cfg!.schemaVersion).toBe(6)
  })

  it('memoises collections by sessionId', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    const a1 = mod.createMessagesCollection('sess-a')
    const a2 = mod.createMessagesCollection('sess-a')
    const b = mod.createMessagesCollection('sess-b')

    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)

    const ids = new Set(capturedConfigs.map((c) => c.id))
    expect(ids.has('messages:sess-a')).toBe(true)
    expect(ids.has('messages:sess-b')).toBe(true)
  })

  it('queryFn cold-start (empty collection) issues REST without cursor params', async () => {
    vi.resetModules()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    // @ts-expect-error — jsdom doesn't ship fetch; assign a minimal stub.
    globalThis.fetch = mockFetch

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('cold-sess')

    const cfg = capturedConfigs.find((c) => c.id === 'messages:cold-sess')
    expect(cfg).toBeDefined()
    const rows = (await cfg!.queryFn()) as Array<{ id: string; sessionId: string }>
    expect(mockFetch).toHaveBeenCalledWith('/api/sessions/cold-sess/messages')
    expect(rows[0].id).toBe('m1')
    expect(rows[0].sessionId).toBe('cold-sess')
  })

  it('REST body no longer carries `version` — row shape has no seq field', async () => {
    vi.resetModules()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
        ],
      }),
    })
    // @ts-expect-error — jsdom fetch stub
    globalThis.fetch = mockFetch

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('no-seq-sess')

    const cfg = capturedConfigs.find((c) => c.id === 'messages:no-seq-sess')
    const rows = (await cfg!.queryFn()) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect('seq' in rows[0]).toBe(false)
    expect('seq' in rows[1]).toBe(false)
  })

  it('onInsert POSTs {content, clientId, createdAt} extracted from the optimistic row', async () => {
    vi.resetModules()
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    // @ts-expect-error — jsdom fetch stub
    globalThis.fetch = mockFetch

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('insert-sess')

    const cfg = capturedConfigs.find((c) => c.id === 'messages:insert-sess')
    expect(cfg?.onInsert).toBeDefined()

    const optimisticRow = {
      id: 'usr-client-abc',
      sessionId: 'insert-sess',
      role: 'user',
      parts: [{ type: 'text', text: 'hello world' }],
      createdAt: '2026-04-21T00:00:00.000Z',
    }

    await cfg!.onInsert!({
      transaction: { mutations: [{ modified: optimisticRow }] },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions/insert-sess/messages',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'hello world',
          clientId: 'usr-client-abc',
          createdAt: '2026-04-21T00:00:00.000Z',
        }),
      }),
    )
  })

  it('onInsert treats 409 (duplicate clientId) as idempotent success, not throw', async () => {
    vi.resetModules()
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) })
    // @ts-expect-error — jsdom fetch stub
    globalThis.fetch = mockFetch

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('retry-sess')
    const cfg = capturedConfigs.find((c) => c.id === 'messages:retry-sess')

    await expect(
      cfg!.onInsert!({
        transaction: {
          mutations: [
            {
              modified: {
                id: 'usr-client-dup',
                sessionId: 'retry-sess',
                role: 'user',
                parts: [{ type: 'text', text: 'x' }],
                createdAt: '2026-04-21T00:00:00.000Z',
              },
            },
          ],
        },
      }),
    ).resolves.toBeUndefined()
  })

  it('onInsert throws on non-409 errors (triggers optimistic rollback)', async () => {
    vi.resetModules()
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    // @ts-expect-error — jsdom fetch stub
    globalThis.fetch = mockFetch

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('err-sess')
    const cfg = capturedConfigs.find((c) => c.id === 'messages:err-sess')

    await expect(
      cfg!.onInsert!({
        transaction: {
          mutations: [
            {
              modified: {
                id: 'usr-client-x',
                sessionId: 'err-sess',
                role: 'user',
                parts: [{ type: 'text', text: 'x' }],
                createdAt: '2026-04-21T00:00:00.000Z',
              },
            },
          ],
        },
      }),
    ).rejects.toThrow(/sendMessage REST 500/)
  })

  it('wire: a SyncedCollectionFrame delivered through subscribeSessionStream reaches the collection iterator', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    mod.createMessagesCollection('sync-sess')

    const cfg = capturedConfigs.find((c) => c.id === 'messages:sync-sess')
    expect(cfg).toBeDefined()

    // Drive a frame directly through the injected subscribe handler's
    // registered callback — emulates the DO pushing a delta frame.
    const handlers = frameHandlers.get('sync-sess')
    expect(handlers).toBeDefined()
    expect(handlers!.size).toBe(1)

    for (const h of handlers!) {
      h({
        type: 'synced-collection-delta',
        collection: 'messages:sync-sess',
        ops: [
          {
            type: 'insert',
            value: {
              id: 'usr-1',
              sessionId: 'sync-sess',
              role: 'user',
              parts: [{ type: 'text', text: 'hi' }],
              createdAt: '2026-04-21T00:00:00.000Z',
            },
          },
        ],
      })
    }

    // Fake collection writes into `store` via getKey on insert/update ops.
    expect(store.has('usr-1')).toBe(true)
    const row = store.get('usr-1') as { id: string; role: string }
    expect(row.role).toBe('user')
  })

  it('wire: frames for other sessions are ignored (collection filter)', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    mod.createMessagesCollection('iso-sess')

    const handlers = frameHandlers.get('iso-sess')
    for (const h of handlers!) {
      h({
        type: 'synced-collection-delta',
        collection: 'messages:other-sess',
        ops: [{ type: 'insert', value: { id: 'noise', role: 'user' } }],
      })
    }
    expect(store.has('noise')).toBe(false)
  })

  it('exports CachedMessage type that omits seq (B6)', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const msg: mod.CachedMessage = {
      id: 'msg-1',
      sessionId: 'session-abc',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
      createdAt: '2026-01-01T00:00:00Z',
    }
    expect(msg.id).toBe('msg-1')
    expect(msg.sessionId).toBe('session-abc')
    // @ts-expect-error — `seq` is no longer part of CachedMessage (B6)
    msg.seq = 1
  })
})

describe('evictOldMessages', () => {
  beforeEach(() => {
    store.clear()
    capturedConfigs.length = 0
    frameHandlers.clear()
    reconnectHandlers.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes messages older than 30 days across every cached collection', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const thirtyOneDaysAgo = new Date()
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31)
    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)

    // Seed the shared store (backing the fake collection) with two rows.
    store.set('old-1', {
      id: 'old-1',
      createdAt: thirtyOneDaysAgo.toISOString(),
      sessionId: 's1',
    })
    store.set('recent-1', {
      id: 'recent-1',
      createdAt: twoDaysAgo.toISOString(),
      sessionId: 's1',
    })

    // Ensure at least one cached collection exists.
    const coll = mod.createMessagesCollection('evict-sess')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evictDeleteSpy = (coll as any).delete as ReturnType<typeof vi.fn>
    // The module also auto-registers a legacy singleton collection.
    // `evictOldMessages` iterates every cached collection and calls each
    // one's `delete` — and since the fakes share a store, only the first
    // iteration finds stale rows. Assert that SOME collection saw the
    // stale key by capturing every captured collection's delete spy.
    const allDeleteSpies = capturedConfigs.map(
      // Each captured config's collection lives at mockCreateSyncedCollection's
      // return — re-derive via the factory mock's .mock.results.
      (_, i) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mockCreateSyncedCollection.mock.results[i].value as any).delete as ReturnType<
          typeof vi.fn
        >,
    )

    mod.evictOldMessages()

    const calls = allDeleteSpies.flatMap((spy) => spy.mock.calls)
    expect(calls).toContainEqual([['old-1']])
    // Also sanity: the target collection exists and is wired.
    expect(evictDeleteSpy).toBeDefined()
  })

  it('does not delete when no messages are stale', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)
    store.set('recent-1', {
      id: 'recent-1',
      createdAt: twoDaysAgo.toISOString(),
      sessionId: 's1',
    })

    const coll = mod.createMessagesCollection('evict-sess-2')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteSpy = (coll as any).delete as ReturnType<typeof vi.fn>
    mod.evictOldMessages()

    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('handles empty collection gracefully', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const coll = mod.createMessagesCollection('evict-sess-3')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteSpy = (coll as any).delete as ReturnType<typeof vi.fn>
    mod.evictOldMessages()

    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('skips messages without createdAt', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    store.set('no-date', { id: 'no-date', sessionId: 's1' })

    const coll = mod.createMessagesCollection('evict-sess-4')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteSpy = (coll as any).delete as ReturnType<typeof vi.fn>
    mod.evictOldMessages()

    expect(deleteSpy).not.toHaveBeenCalled()
  })
})
