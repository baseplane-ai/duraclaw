/**
 * @vitest-environment jsdom
 *
 * GH#47 sibling refactor: branch-info-collection migrated onto the
 * SyncConfig-direct pattern. Tests verify the factory (a) builds a raw
 * `CollectionConfig` with the right id / getKey, (b) memoises per
 * sessionId, (c) routes `branchInfo:<sessionId>` delta frames through
 * begin/write/commit, (d) calls markReady eagerly.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capturedConfigs: any[] = []

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
        const row = msg.value as { parentMsgId: string }
        store.set(row.parentMsgId, row)
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
    [Symbol.iterator]: () => store.entries(),
    __config: config,
  }
}

vi.mock('@tanstack/db', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCollection: vi.fn((config: any) => {
    capturedConfigs.push(config)
    return makeFakeCollection(config)
  }),
}))

vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (opts: any) => opts,
  ),
}))

vi.mock('./db-instance', () => ({
  dbReady: Promise.resolve(null),
  // GH#164: collection modules now read persistence synchronously.
  getResolvedPersistence: () => null,
  queryClient: { invalidateQueries: vi.fn() },
}))

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

describe('branch-info-collection (GH#47 — WS-only SyncConfig path)', () => {
  beforeEach(() => {
    capturedConfigs.length = 0
    frameHandlers.clear()
    reconnectHandlers.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports createBranchInfoCollection factory + branchInfoCollectionOptions', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    expect(typeof mod.createBranchInfoCollection).toBe('function')
    expect(typeof mod.branchInfoCollectionOptions).toBe('function')
  })

  it('builds CollectionConfig with per-session id, getKey, and sync.sync fn', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('sess-a')

    expect(capturedConfigs).toHaveLength(1)
    const cfg = capturedConfigs[0] as CollectionConfig<{ parentMsgId: string }>
    expect(cfg.id).toBe('branch_info:sess-a')
    expect(cfg.getKey({ parentMsgId: 'usr-7' } as { parentMsgId: string })).toBe('usr-7')
    expect(typeof cfg.sync.sync).toBe('function')
  })

  it('does NOT set queryFn / queryKey — DO onConnect replay is the cold-load channel', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('no-query-sess')

    const cfg = capturedConfigs[0]
    expect('queryFn' in cfg).toBe(false)
    expect('queryKey' in cfg).toBe(false)
  })

  it('sync.sync subscribes to the per-session stream and calls markReady eagerly', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const coll = mod.createBranchInfoCollection('ready-sess') as {
      markReady: ReturnType<typeof vi.fn>
    }

    expect(frameHandlers.get('ready-sess')?.size).toBe(1)
    expect(reconnectHandlers.get('ready-sess')?.size).toBe(1)
    expect(coll.markReady).toHaveBeenCalledTimes(1)
  })

  it('routes an insert delta frame on branchInfo:<sessionId> through begin/write/commit', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const coll = mod.createBranchInfoCollection('sync-sess') as {
      store: Map<string, { parentMsgId: string; activeId: string }>
    }

    for (const h of frameHandlers.get('sync-sess')!) {
      h({
        type: 'synced-collection-delta',
        collection: 'branchInfo:sync-sess',
        ops: [
          {
            type: 'insert',
            value: {
              parentMsgId: 'msg-0',
              sessionId: 'sync-sess',
              siblings: ['usr-1', 'usr-3'],
              activeId: 'usr-1',
              updatedAt: '2026-04-21T00:00:00Z',
            },
          },
        ],
      })
    }

    expect(coll.store.has('msg-0')).toBe(true)
    expect(coll.store.get('msg-0')!.activeId).toBe('usr-1')
  })

  it('converts insert→update when parentMsgId is already present (reconnect idempotence)', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const coll = mod.createBranchInfoCollection('idem-sess') as {
      store: Map<string, { parentMsgId: string; activeId: string }>
    }
    const handlers = frameHandlers.get('idem-sess')!

    for (const h of handlers) {
      h({
        type: 'synced-collection-delta',
        collection: 'branchInfo:idem-sess',
        ops: [
          {
            type: 'insert',
            value: {
              parentMsgId: 'msg-0',
              sessionId: 'idem-sess',
              siblings: ['usr-1'],
              activeId: 'usr-1',
              updatedAt: '2026-04-21T00:00:00Z',
            },
          },
        ],
      })
    }
    expect(coll.store.get('msg-0')!.activeId).toBe('usr-1')

    // Re-emit with a different activeId — should not throw, should overwrite.
    for (const h of handlers) {
      h({
        type: 'synced-collection-delta',
        collection: 'branchInfo:idem-sess',
        ops: [
          {
            type: 'insert',
            value: {
              parentMsgId: 'msg-0',
              sessionId: 'idem-sess',
              siblings: ['usr-1', 'usr-5'],
              activeId: 'usr-5',
              updatedAt: '2026-04-21T00:01:00Z',
            },
          },
        ],
      })
    }
    expect(coll.store.get('msg-0')!.activeId).toBe('usr-5')
  })

  it('applies delete ops — row is removed from store', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const coll = mod.createBranchInfoCollection('del-sess') as {
      store: Map<string, unknown>
    }

    for (const h of frameHandlers.get('del-sess')!) {
      h({
        type: 'synced-collection-delta',
        collection: 'branchInfo:del-sess',
        ops: [
          {
            type: 'insert',
            value: {
              parentMsgId: 'msg-0',
              sessionId: 'del-sess',
              siblings: ['usr-1'],
              activeId: 'usr-1',
              updatedAt: '2026-04-21T00:00:00Z',
            },
          },
        ],
      })
      h({
        type: 'synced-collection-delta',
        collection: 'branchInfo:del-sess',
        ops: [{ type: 'delete', key: 'msg-0' }],
      })
    }
    expect(coll.store.has('msg-0')).toBe(false)
  })

  it('ignores frames whose collection targets a different session or a messages channel', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const coll = mod.createBranchInfoCollection('iso-sess') as {
      store: Map<string, unknown>
    }

    for (const h of frameHandlers.get('iso-sess')!) {
      h({
        type: 'synced-collection-delta',
        collection: 'branchInfo:other-sess',
        ops: [{ type: 'insert', value: { parentMsgId: 'noise', sessionId: 'other-sess' } }],
      })
      // Messages-channel frame on the same session must also be ignored.
      h({
        type: 'synced-collection-delta',
        collection: 'messages:iso-sess',
        ops: [{ type: 'insert', value: { parentMsgId: 'wrong-channel' } }],
      })
    }
    expect(coll.store.has('noise')).toBe(false)
    expect(coll.store.has('wrong-channel')).toBe(false)
  })

  it('cleanup unsubscribes both frame + reconnect handlers', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const coll = mod.createBranchInfoCollection('unsub-sess') as { cleanup: () => void }
    expect(frameHandlers.get('unsub-sess')?.size).toBe(1)
    expect(reconnectHandlers.get('unsub-sess')?.size).toBe(1)

    coll.cleanup()

    expect(frameHandlers.get('unsub-sess')?.size ?? 0).toBe(0)
    expect(reconnectHandlers.get('unsub-sess')?.size ?? 0).toBe(0)
  })

  it('memoises collections by sessionId', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')

    const a1 = mod.createBranchInfoCollection('sess-memo')
    const a2 = mod.createBranchInfoCollection('sess-memo')
    const b = mod.createBranchInfoCollection('sess-other')

    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(capturedConfigs).toHaveLength(2)
    expect(capturedConfigs[0].id).toBe('branch_info:sess-memo')
    expect(capturedConfigs[1].id).toBe('branch_info:sess-other')
  })

  it('re-exports BranchInfoRow type', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const row: mod.BranchInfoRow = {
      parentMsgId: 'msg-0',
      sessionId: 'sess-t',
      siblings: ['usr-1', 'usr-3'],
      activeId: 'usr-1',
      updatedAt: '2026-04-19T00:00:00Z',
    }
    expect(row.parentMsgId).toBe('msg-0')
    expect(row.siblings).toHaveLength(2)
  })
})
