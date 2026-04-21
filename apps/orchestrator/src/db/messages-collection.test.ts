/**
 * @vitest-environment jsdom
 *
 * Unit tests for the per-sessionId messages-collection factory (GH#47).
 *
 * Strategy: the factory now builds a raw `CollectionConfig` directly (no
 * `createSyncedCollection` seam). We stub `persistedCollectionOptions` and
 * `createCollection` as pass-throughs, capture the config that reaches
 * `createCollection`, and drive the captured `sync.sync` with a fake
 * params object whose `begin/write/commit` route into a local Map — so we
 * can assert the end-to-end WS → collection wire.
 */

import type { CollectionConfig } from '@tanstack/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeSyncParams {
  begin: () => void
  write: (msg: { type: string; key?: string; value?: unknown }) => void
  commit: () => void
  markReady: () => void
  collection: { has: (key: string) => boolean }
}

// Captured configs for each createCollection() invocation.
// Use `any` so the test harness can read internal sync params without
// fighting @tanstack/db's tight generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capturedConfigs: any[] = []

// Per-collection backing store + a helper to drive sync.sync with a fake
// params object that routes begin/write/commit through the store.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeCollection(config: any) {
  const store = new Map<string, unknown>()
  const markReady = vi.fn()

  const fakeParams: FakeSyncParams = {
    begin: () => {},
    write: (msg) => {
      if (msg.type === 'delete') {
        store.delete(msg.key as string)
      } else {
        const row = msg.value as { id: string }
        store.set(row.id, row)
      }
    },
    commit: () => {},
    markReady,
    collection: { has: (key: string) => store.has(key) },
  }
  const cleanup = config.sync.sync(fakeParams)

  return {
    store,
    markReady,
    cleanup,
    // Iterator surface the factory's evictOldMessages relies on.
    [Symbol.iterator]: () => store.entries(),
    delete: vi.fn((keys: string | string[]) => {
      const ids = Array.isArray(keys) ? keys : [keys]
      for (const id of ids) store.delete(id)
    }),
    insert: vi.fn(),
    utils: {},
    __config: config,
  }
}

// Mock @tanstack/db.createCollection — capture config, return a fake
// collection whose sync.sync is driven immediately (mimicking @tanstack/db's
// eager sync-start behaviour for the test harness).
vi.mock('@tanstack/db', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCollection: vi.fn((config: any) => {
    capturedConfigs.push(config)
    return makeFakeCollection(config)
  }),
}))

// Mock persistedCollectionOptions as a pass-through so the unwrapped
// CollectionConfig reaches our createCollection stub unchanged.
vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (opts: any) => opts,
  ),
}))

vi.mock('./db-instance', () => ({
  // Null persistence so the factory skips the persistedCollectionOptions
  // wrap — we still assert it's invoked with the right shape in the
  // dedicated test below by toggling this.
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

describe('messages-collection factory (GH#47 — WS-only SyncConfig path)', () => {
  beforeEach(() => {
    capturedConfigs.length = 0
    frameHandlers.clear()
    reconnectHandlers.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports createMessagesCollection factory, messagesCollectionOptions, and legacy singleton', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    expect(mod.createMessagesCollection).toBeDefined()
    expect(typeof mod.createMessagesCollection).toBe('function')
    expect(mod.messagesCollectionOptions).toBeDefined()
    expect(typeof mod.messagesCollectionOptions).toBe('function')
    expect(mod.messagesCollection).toBeDefined()
  })

  it('builds CollectionConfig with id, getKey, and sync.sync fn', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    mod.createMessagesCollection('sess-1')

    const cfg = capturedConfigs.find((c) => c.id === 'messages:sess-1') as
      | CollectionConfig<{ id: string }>
      | undefined
    expect(cfg).toBeDefined()
    expect(cfg!.getKey({ id: 'msg-123' } as { id: string })).toBe('msg-123')
    expect(typeof cfg!.sync.sync).toBe('function')
  })

  it('does NOT set a queryFn — WS onConnect replay is the cold-load channel', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    mod.createMessagesCollection('no-query-sess')

    const cfg = capturedConfigs.find((c) => c.id === 'messages:no-query-sess')
    expect(cfg).toBeDefined()
    // No queryFn / queryKey / queryClient surface on the raw CollectionConfig
    // (those were queryCollectionOptions-only).
    expect('queryFn' in cfg).toBe(false)
    expect('queryKey' in cfg).toBe(false)
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

  it('sync.sync subscribes to the per-session stream and calls markReady eagerly', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    const coll = mod.createMessagesCollection('ready-sess') as {
      markReady: ReturnType<typeof vi.fn>
    }

    // subscribe handler registered on the sessionId's set
    expect(frameHandlers.get('ready-sess')?.size).toBe(1)
    // reconnect handler registered too
    expect(reconnectHandlers.get('ready-sess')?.size).toBe(1)
    // markReady fired at sync-start (eager — no snapshot to wait for)
    expect(coll.markReady).toHaveBeenCalledTimes(1)
  })

  it('routes an insert delta frame through begin/write/commit to the store', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    const coll = mod.createMessagesCollection('sync-sess') as {
      store: Map<string, { id: string; role: string }>
    }

    for (const h of frameHandlers.get('sync-sess')!) {
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

    expect(coll.store.has('usr-1')).toBe(true)
    expect(coll.store.get('usr-1')!.role).toBe('user')
  })

  it('converts insert→update when the key is already present (reconnect replay idempotence)', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    const coll = mod.createMessagesCollection('idem-sess') as {
      store: Map<string, { id: string; parts: Array<{ text?: string }> }>
    }
    const handlers = frameHandlers.get('idem-sess')!

    // First insert — key is absent → applies as insert.
    for (const h of handlers) {
      h({
        type: 'synced-collection-delta',
        collection: 'messages:idem-sess',
        ops: [
          {
            type: 'insert',
            value: {
              id: 'asst-1',
              sessionId: 'idem-sess',
              role: 'assistant',
              parts: [{ type: 'text', text: 'partial' }],
            },
          },
        ],
      })
    }
    expect(coll.store.get('asst-1')!.parts[0]!.text).toBe('partial')

    // Re-emit same id with different value — the factory should convert to
    // update so the store overwrites, not throws.
    for (const h of handlers) {
      h({
        type: 'synced-collection-delta',
        collection: 'messages:idem-sess',
        ops: [
          {
            type: 'insert',
            value: {
              id: 'asst-1',
              sessionId: 'idem-sess',
              role: 'assistant',
              parts: [{ type: 'text', text: 'full' }],
            },
          },
        ],
      })
    }
    expect(coll.store.get('asst-1')!.parts[0]!.text).toBe('full')
  })

  it('applies delete ops — row is removed from store', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    const coll = mod.createMessagesCollection('del-sess') as {
      store: Map<string, unknown>
    }
    const handlers = frameHandlers.get('del-sess')!

    for (const h of handlers) {
      h({
        type: 'synced-collection-delta',
        collection: 'messages:del-sess',
        ops: [
          {
            type: 'insert',
            value: { id: 'm-doomed', sessionId: 'del-sess', role: 'user', parts: [] },
          },
        ],
      })
      h({
        type: 'synced-collection-delta',
        collection: 'messages:del-sess',
        ops: [{ type: 'delete', key: 'm-doomed' }],
      })
    }
    expect(coll.store.has('m-doomed')).toBe(false)
  })

  it('ignores frames whose collection name targets a different session', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    const coll = mod.createMessagesCollection('iso-sess') as {
      store: Map<string, unknown>
    }

    for (const h of frameHandlers.get('iso-sess')!) {
      h({
        type: 'synced-collection-delta',
        collection: 'messages:other-sess',
        ops: [{ type: 'insert', value: { id: 'noise', role: 'user' } }],
      })
    }
    expect(coll.store.has('noise')).toBe(false)
  })

  it('cleanup unsubscribes both frame + reconnect handlers', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    const coll = mod.createMessagesCollection('unsub-sess') as { cleanup: () => void }
    expect(frameHandlers.get('unsub-sess')?.size).toBe(1)
    expect(reconnectHandlers.get('unsub-sess')?.size).toBe(1)

    coll.cleanup()

    expect(frameHandlers.get('unsub-sess')?.size ?? 0).toBe(0)
    expect(reconnectHandlers.get('unsub-sess')?.size ?? 0).toBe(0)
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

    await cfg!.onInsert!({
      transaction: {
        mutations: [
          {
            modified: {
              id: 'usr-client-abc',
              sessionId: 'insert-sess',
              role: 'user',
              parts: [{ type: 'text', text: 'hello world' }],
              createdAt: '2026-04-21T00:00:00.000Z',
            },
          },
        ],
      },
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

    const coll = mod.createMessagesCollection('evict-sess') as {
      store: Map<string, unknown>
      delete: ReturnType<typeof vi.fn>
    }
    coll.store.set('old-1', {
      id: 'old-1',
      createdAt: thirtyOneDaysAgo.toISOString(),
      sessionId: 'evict-sess',
    })
    coll.store.set('recent-1', {
      id: 'recent-1',
      createdAt: twoDaysAgo.toISOString(),
      sessionId: 'evict-sess',
    })

    mod.evictOldMessages()

    expect(coll.delete).toHaveBeenCalledWith(['old-1'])
  })

  it('does not delete when no messages are stale', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)
    const coll = mod.createMessagesCollection('evict-sess-2') as {
      store: Map<string, unknown>
      delete: ReturnType<typeof vi.fn>
    }
    coll.store.set('recent-1', {
      id: 'recent-1',
      createdAt: twoDaysAgo.toISOString(),
      sessionId: 'evict-sess-2',
    })

    mod.evictOldMessages()

    expect(coll.delete).not.toHaveBeenCalled()
  })

  it('handles empty collection gracefully', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const coll = mod.createMessagesCollection('evict-sess-3') as {
      delete: ReturnType<typeof vi.fn>
    }
    mod.evictOldMessages()

    expect(coll.delete).not.toHaveBeenCalled()
  })

  it('skips messages without createdAt', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const coll = mod.createMessagesCollection('evict-sess-4') as {
      store: Map<string, unknown>
      delete: ReturnType<typeof vi.fn>
    }
    coll.store.set('no-date', { id: 'no-date', sessionId: 'evict-sess-4' })

    mod.evictOldMessages()

    expect(coll.delete).not.toHaveBeenCalled()
  })
})
