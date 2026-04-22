/**
 * @vitest-environment jsdom
 *
 * Unit tests for createSyncedCollection (GH#32 p1).
 *
 * Strategy: mock @tanstack/db, @tanstack/query-db-collection,
 * @tanstack/browser-db-sqlite-persistence, and ~/hooks/use-user-stream so
 * we can drive the factory's sync-wrapped callback directly and observe
 * the exact sequence of begin / write / commit calls plus the reconnect /
 * queryFn re-invocation. This matches the deterministic signal the spec
 * calls for in VP4 and across the p1 test_cases.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────

const mockCreateCollection = vi.fn().mockImplementation((opts) => ({
  __opts: opts,
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  utils: { refetch: vi.fn() },
}))

const mockQueryCollectionOptions = vi.fn().mockImplementation((config) => ({
  id: config.id,
  __config: config,
  sync: {
    sync: vi.fn().mockImplementation((_params: unknown) => {
      // Default "original sync" just fires markReady and returns no cleanup.
      const p = _params as { markReady?: () => void }
      p.markReady?.()
      return undefined
    }),
  },
}))

const mockPersistedCollectionOptions = vi
  .fn()
  .mockImplementation((config) => ({ ...config, __wrappedByPersistence: true }))

const mockInvalidateQueries = vi.fn()

// Per-test storage for subscribeUserStream registrations so tests can push
// frames and observe handler invocations.
type FrameHandler = (frame: SyncedCollectionFrame<unknown>) => void
type ReconnectHandler = () => void

const frameHandlersByType = new Map<string, Set<FrameHandler>>()
const reconnectHandlers = new Set<ReconnectHandler>()

const mockSubscribeUserStream = vi.fn((frameType: string, handler: FrameHandler) => {
  let set = frameHandlersByType.get(frameType)
  if (!set) {
    set = new Set()
    frameHandlersByType.set(frameType, set)
  }
  set.add(handler)
  return () => {
    const current = frameHandlersByType.get(frameType)
    current?.delete(handler)
  }
})

const mockOnUserStreamReconnect = vi.fn((cb: ReconnectHandler) => {
  reconnectHandlers.add(cb)
  return () => {
    reconnectHandlers.delete(cb)
  }
})

vi.mock('@tanstack/db', () => ({
  createCollection: mockCreateCollection,
}))

vi.mock('@tanstack/query-db-collection', () => ({
  queryCollectionOptions: mockQueryCollectionOptions,
}))

vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: mockPersistedCollectionOptions,
}))

vi.mock('~/hooks/use-user-stream', () => ({
  subscribeUserStream: mockSubscribeUserStream,
  onUserStreamReconnect: mockOnUserStreamReconnect,
}))

vi.mock('./db-instance', () => ({
  queryClient: { invalidateQueries: mockInvalidateQueries },
  dbReady: Promise.resolve(null),
}))

// ── Helpers ──────────────────────────────────────────────────────────────

interface CapturedSync {
  begin: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  markReady: ReturnType<typeof vi.fn>
  truncate: ReturnType<typeof vi.fn>
  cleanup: (() => void) | void
}

/**
 * Build a fresh sync-params stub, run the factory's wrapped sync fn, and
 * return the captured begin/write/commit spies plus the cleanup fn.
 */
function driveSync(collection: { __opts: { sync: { sync: Function } } }): CapturedSync {
  const begin = vi.fn()
  const write = vi.fn()
  const commit = vi.fn()
  const markReady = vi.fn()
  const truncate = vi.fn()

  const cleanup = collection.__opts.sync.sync({
    collection: {},
    begin,
    write,
    commit,
    markReady,
    truncate,
  }) as (() => void) | void

  return { begin, write, commit, markReady, truncate, cleanup }
}

function emitFrame(collectionName: string, frame: SyncedCollectionFrame<unknown>) {
  const handlers = frameHandlersByType.get(collectionName)
  if (!handlers) return
  for (const h of handlers) h(frame)
}

function triggerReconnect() {
  for (const cb of reconnectHandlers) cb()
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('createSyncedCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    frameHandlersByType.clear()
    reconnectHandlers.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('factory-initial-load: runs queryFn via the wrapped sync and markReady fires', async () => {
    const rows = [
      { id: 'a', name: 'one' },
      { id: 'b', name: 'two' },
      { id: 'c', name: 'three' },
    ]

    // The mocked original sync invokes markReady synchronously — we assert
    // that our wrapper preserves that path end-to-end.
    const { createSyncedCollection } = await import('./synced-collection')

    const queryFn = vi.fn().mockResolvedValue(rows)
    const coll = createSyncedCollection<(typeof rows)[number], string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn,
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const captured = driveSync(coll)

    // queryFn reference threaded into queryCollectionOptions
    const qcoCall = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'user_tabs',
    )
    expect(qcoCall).toBeDefined()
    expect((qcoCall![0] as { queryFn: typeof queryFn }).queryFn).toBe(queryFn)

    // Initial-load path preserved: the original sync's markReady fires.
    expect(captured.markReady).toHaveBeenCalled()
  })

  it('delta-frame-routing: only the matching syncFrameType handler receives ops', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const tabs = createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const prefs = createSyncedCollection<{ userId: string }, string>({
      id: 'user_preferences',
      getKey: (r) => r.userId,
      queryKey: ['user_preferences'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_preferences',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const tabsCap = driveSync(tabs)
    const prefsCap = driveSync(prefs)

    const row = { id: 't1', userId: 'u1' }
    emitFrame('user_tabs', {
      type: 'synced-collection-delta',
      collection: 'user_tabs',
      ops: [{ type: 'insert', value: row }],
    })

    // tabs saw begin / write(insert) / commit exactly once.
    expect(tabsCap.begin).toHaveBeenCalledTimes(1)
    expect(tabsCap.write).toHaveBeenCalledTimes(1)
    expect(tabsCap.write).toHaveBeenCalledWith({ type: 'insert', value: row })
    expect(tabsCap.commit).toHaveBeenCalledTimes(1)

    // prefs was untouched.
    expect(prefsCap.begin).not.toHaveBeenCalled()
    expect(prefsCap.write).not.toHaveBeenCalled()
    expect(prefsCap.commit).not.toHaveBeenCalled()
  })

  it('delete op writes {type:delete,key} shape (not value)', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const cap = driveSync(coll)

    emitFrame('user_tabs', {
      type: 'synced-collection-delta',
      collection: 'user_tabs',
      ops: [{ type: 'delete', key: 't1' }],
    })

    expect(cap.write).toHaveBeenCalledTimes(1)
    const firstCall = cap.write.mock.calls[0][0] as {
      type: string
      key?: string
    }
    expect(firstCall.type).toBe('delete')
    expect(firstCall.key).toBe('t1')
  })

  it('insert-upsert: converts insert→update when collection.has(key) is true (GH#41 streaming regression)', async () => {
    // Regression: TanStack DB's sync layer throws DuplicateKeySyncError on
    // `write({type:'insert'})` when the key is already present and the new
    // value !== deepEquals the existing. Streaming partial_assistant turns
    // re-emit the same row id with growing text — every delta after the
    // first would throw, aborting the frame and silently freezing the UI.
    // Repro: session.getHistory() snapshot on onConnect re-inserts rows the
    // OPFS-persisted cache already carries; the first collision kills the
    // snapshot, and subsequent partial_assistant deltas deepEquals-mismatch
    // and also throw. Fix: factory auto-converts insert→update when
    // collection.has(key) is true so writes stay idempotent.
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string; text: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const begin = vi.fn()
    const write = vi.fn()
    const commit = vi.fn()
    const markReady = vi.fn()
    const truncate = vi.fn()

    // Stub a collection whose has() reports t1 as already synced.
    coll.__opts.sync.sync({
      collection: { has: (k: string) => k === 't1' },
      begin,
      write,
      commit,
      markReady,
      truncate,
    })

    // New row (t2) arrives as insert — should stay insert.
    // Updated row (t1) arrives as insert — should be rewritten to update.
    emitFrame('user_tabs', {
      type: 'synced-collection-delta',
      collection: 'user_tabs',
      ops: [
        { type: 'insert', value: { id: 't1', text: 'growing…' } },
        { type: 'insert', value: { id: 't2', text: 'net-new' } },
      ],
    })

    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenNthCalledWith(1, {
      type: 'update',
      value: { id: 't1', text: 'growing…' },
    })
    expect(write).toHaveBeenNthCalledWith(2, {
      type: 'insert',
      value: { id: 't2', text: 'net-new' },
    })
  })

  it('loopback-dedup: server-echo frame writes once per optimistic insert (2 total via sync)', async () => {
    // Semantics per B6: `SyncConfig.write()` fires exactly twice — once for
    // the optimistic apply (simulated here by driving write() via the caller
    // pattern) and once for the echo-settle via the delta frame. Loopback
    // de-duplication is TanStack DB's deep-equality responsibility; we only
    // verify the factory does not introduce a THIRD write for a matching echo.
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string; text: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const cap = driveSync(coll)

    // 1) Optimistic apply — caller writes directly.
    cap.begin()
    cap.write({ type: 'insert', value: { id: 't1', text: 'hi' } })
    cap.commit()

    // 2) Server echo arrives via the stream — factory applies it.
    emitFrame('user_tabs', {
      type: 'synced-collection-delta',
      collection: 'user_tabs',
      ops: [{ type: 'insert', value: { id: 't1', text: 'hi' } }],
    })

    expect(cap.write).toHaveBeenCalledTimes(2)
  })

  it('snapshot-frame: upserts all rows and deletes local keys not in the snapshot', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string; text: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const begin = vi.fn()
    const write = vi.fn()
    const commit = vi.fn()
    const markReady = vi.fn()
    const truncate = vi.fn()

    // Stub a collection that has t1 and t2, but the snapshot only contains t1 and t3.
    // t2 should be deleted, t1 updated, t3 inserted.
    coll.__opts.sync.sync({
      collection: {
        has: (k: string) => k === 't1' || k === 't2',
        keys: () => ['t1', 't2'],
      },
      begin,
      write,
      commit,
      markReady,
      truncate,
    })

    emitFrame('user_tabs', {
      type: 'synced-collection-delta',
      collection: 'user_tabs',
      snapshot: true,
      ops: [
        { type: 'insert', value: { id: 't1', text: 'updated' } },
        { type: 'insert', value: { id: 't3', text: 'new' } },
      ],
    })

    expect(begin).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
    // 3 writes: t1 update, t3 insert, t2 delete
    expect(write).toHaveBeenCalledTimes(3)
    expect(write).toHaveBeenCalledWith({ type: 'update', value: { id: 't1', text: 'updated' } })
    expect(write).toHaveBeenCalledWith({ type: 'insert', value: { id: 't3', text: 'new' } })
    expect(write).toHaveBeenCalledWith({
      type: 'delete',
      key: 't2',
      value: undefined,
    })
  })

  it('snapshot-frame: empty snapshot deletes all local rows', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const begin = vi.fn()
    const write = vi.fn()
    const commit = vi.fn()
    const markReady = vi.fn()
    const truncate = vi.fn()

    coll.__opts.sync.sync({
      collection: {
        has: (k: string) => k === 't1',
        keys: () => ['t1'],
      },
      begin,
      write,
      commit,
      markReady,
      truncate,
    })

    emitFrame('user_tabs', {
      type: 'synced-collection-delta',
      collection: 'user_tabs',
      snapshot: true,
      ops: [],
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({
      type: 'delete',
      key: 't1',
      value: undefined,
    })
  })

  it('reconnect-post-response-lost: onUserStreamReconnect invalidates the query', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    driveSync(coll)

    triggerReconnect()

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['user_tabs'] })
  })

  it('cleanup unsubscribes frame + reconnect handlers and invokes original cleanup', async () => {
    // Arrange: original sync returns a cleanup fn we can spy on.
    const originalCleanup = vi.fn()
    mockQueryCollectionOptions.mockImplementationOnce((config) => ({
      id: config.id,
      __config: config,
      sync: {
        sync: (_params: { markReady?: () => void }) => {
          _params.markReady?.()
          return originalCleanup
        },
      },
    }))

    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const cap = driveSync(coll)
    expect(frameHandlersByType.get('user_tabs')?.size).toBe(1)
    expect(reconnectHandlers.size).toBe(1)

    // Act: invoke the cleanup returned by the wrapped sync.
    expect(typeof cap.cleanup).toBe('function')
    ;(cap.cleanup as () => void)()

    // Assert: handlers gone, original cleanup fired.
    expect(frameHandlersByType.get('user_tabs')?.size ?? 0).toBe(0)
    expect(reconnectHandlers.size).toBe(0)
    expect(originalCleanup).toHaveBeenCalledTimes(1)
  })

  it('reconnect-post-never-reached: queryFn rejection is observable via queryInvalidate → caller refetch', async () => {
    // The factory does not execute queryFn directly on reconnect — it
    // invalidates the query and lets TanStack Query re-run queryFn with
    // configured retry/timeout. This test verifies the invalidation path
    // fires exactly once per reconnect and carries the right queryKey,
    // which is the contract TanStack Query consumes. A rejecting queryFn
    // would then surface via applyFailedResult / optimistic rollback —
    // out of our wrap's responsibility.
    const { createSyncedCollection } = await import('./synced-collection')

    const queryFn = vi.fn().mockRejectedValue(new Error('network down'))
    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn,
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    driveSync(coll)
    triggerReconnect()

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['user_tabs'] })
    // queryFn is handed to queryCollectionOptions — the factory does NOT
    // call it directly on reconnect. Verified by asserting our wrap never
    // invokes the passed queryFn.
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('reconnect-delete-lost: factory re-invalidates; optimistic delete reappearance is TanStack DB rollback behavior (not factory)', async () => {
    // Same shape as reconnect-post-never-reached — the factory's job is to
    // hand the reconnect signal to TanStack Query via invalidateQueries.
    // The row reappearing on failed-delete rollback is an upstream contract
    // we smoke-test here by asserting we do invalidate (not short-circuit).
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [{ id: 't1' }],
      syncFrameType: 'user_tabs',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    driveSync(coll)
    triggerReconnect()
    triggerReconnect()

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2)
  })

  it('applies persistenceWrap when persistence is provided, preserving our sync wrapper', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const fakePersistence = { adapter: {} } as unknown as object

    createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
      // biome-ignore lint/suspicious/noExplicitAny: fake persistence handle
      persistence: fakePersistence as any,
      schemaVersion: 2,
    })

    expect(mockPersistedCollectionOptions).toHaveBeenCalledTimes(1)
    const arg = mockPersistedCollectionOptions.mock.calls[0][0] as {
      persistence: unknown
      schemaVersion: number
      sync: { sync: Function }
    }
    expect(arg.persistence).toBe(fakePersistence)
    expect(arg.schemaVersion).toBe(2)
    // Our wrapped sync is what persistedCollectionOptions sees.
    expect(typeof arg.sync.sync).toBe('function')
  })

  it('configures queryCollectionOptions with staleTime: Infinity, refetchInterval: false, retry: 2, retryDelay: 500', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    createSyncedCollection<{ id: string }, string>({
      id: 'user_tabs',
      getKey: (r) => r.id,
      queryKey: ['user_tabs'] as const,
      queryFn: async () => [],
      syncFrameType: 'user_tabs',
    })

    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'user_tabs',
    )
    expect(call).toBeDefined()
    const cfg = call![0] as {
      staleTime: number
      refetchInterval: unknown
      retry: number
      retryDelay: number
    }
    expect(cfg.staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(cfg.refetchInterval).toBe(false)
    expect(cfg.retry).toBe(2)
    expect(cfg.retryDelay).toBe(500)
  })
})

// ── Injection-param tests (GH#38 P1.1) ───────────────────────────────────
//
// The factory now accepts `subscribe` / `onReconnect` callbacks so callers
// can wire it onto non-user-stream transports (per-session WS for
// messagesCollection). Defaults keep the existing user-stream behavior.
// Tests below exercise:
//   (a) injected `subscribe` receives EVERY frame (no pre-filter) and the
//       factory's internal `frame.collection === opts.collection` filter
//       drops non-matching frames before begin/write/commit
//   (b) injected `onReconnect` fires queryClient.invalidateQueries
//   (c) custom `collection` string wins over `syncFrameType` for the filter

describe('createSyncedCollection — injection params (GH#38 P1.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    frameHandlersByType.clear()
    reconnectHandlers.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('injected-subscribe: factory filters by `collection` and drops non-matching frames', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    // Custom subscribe — simulates the per-session WS primitive which
    // forwards EVERY frame without pre-filtering.
    let capturedHandler: FrameHandler | null = null
    const customSubscribe = vi.fn((h: FrameHandler) => {
      capturedHandler = h
      return () => {
        capturedHandler = null
      }
    })

    const coll = createSyncedCollection<{ id: string; v: number }, string>({
      id: 'messages:abc',
      getKey: (r) => r.id,
      queryKey: ['messages', 'abc'] as const,
      queryFn: async () => [],
      collection: 'messages:abc',
      subscribe: customSubscribe,
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const { begin, write, commit } = driveSync(coll)

    // Custom subscribe should have been registered; user-stream fallback
    // should NOT have been touched.
    expect(customSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribeUserStream).not.toHaveBeenCalled()
    expect(capturedHandler).toBeTypeOf('function')

    // Matching frame → begin/write/commit.
    capturedHandler!({
      type: 'synced-collection-delta',
      collection: 'messages:abc',
      ops: [{ type: 'insert', value: { id: 'm1', v: 1 } }],
    })
    expect(begin).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ type: 'insert', value: { id: 'm1', v: 1 } })
    expect(commit).toHaveBeenCalledTimes(1)

    // Non-matching frame (branchInfo delivered over the same session WS) is
    // dropped by the factory's internal filter — no begin/write/commit.
    capturedHandler!({
      type: 'synced-collection-delta',
      collection: 'branchInfo:abc',
      ops: [{ type: 'insert', value: { id: 'b1', v: 2 } }],
    })
    expect(begin).toHaveBeenCalledTimes(1) // unchanged
    expect(commit).toHaveBeenCalledTimes(1) // unchanged

    // Frame for a different session's messages is also dropped.
    capturedHandler!({
      type: 'synced-collection-delta',
      collection: 'messages:xyz',
      ops: [{ type: 'insert', value: { id: 'm2', v: 3 } }],
    })
    expect(begin).toHaveBeenCalledTimes(1) // still unchanged
  })

  it('injected-onReconnect: fires invalidateQueries on reconnect, replacing the user-stream default', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    let capturedReconnect: ReconnectHandler | null = null
    const customOnReconnect = vi.fn((cb: ReconnectHandler) => {
      capturedReconnect = cb
      return () => {
        capturedReconnect = null
      }
    })

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'messages:abc',
      getKey: (r) => r.id,
      queryKey: ['messages', 'abc'] as const,
      queryFn: async () => [],
      collection: 'messages:abc',
      subscribe: vi.fn(() => () => {}),
      onReconnect: customOnReconnect,
    }) as unknown as { __opts: { sync: { sync: Function } } }

    driveSync(coll)

    // Default user-stream reconnect path must NOT be used when onReconnect
    // is injected.
    expect(mockOnUserStreamReconnect).not.toHaveBeenCalled()
    expect(customOnReconnect).toHaveBeenCalledTimes(1)

    expect(mockInvalidateQueries).not.toHaveBeenCalled()
    capturedReconnect!()
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['messages', 'abc'],
    })
  })

  it('collection-wins-over-syncFrameType: when both set, `collection` is used as the filter key', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    let capturedHandler: FrameHandler | null = null
    const customSubscribe = vi.fn((h: FrameHandler) => {
      capturedHandler = h
      return () => {
        capturedHandler = null
      }
    })

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'messages:abc',
      getKey: (r) => r.id,
      queryKey: ['messages', 'abc'] as const,
      queryFn: async () => [],
      collection: 'messages:abc',
      syncFrameType: 'legacy_ignored',
      subscribe: customSubscribe,
    }) as unknown as { __opts: { sync: { sync: Function } } }

    const { begin, commit } = driveSync(coll)

    // Frame matching `collection` → applied.
    capturedHandler!({
      type: 'synced-collection-delta',
      collection: 'messages:abc',
      ops: [{ type: 'insert', value: { id: 'm1' } }],
    })
    expect(begin).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)

    // Frame matching the legacy syncFrameType → dropped (collection wins).
    capturedHandler!({
      type: 'synced-collection-delta',
      collection: 'legacy_ignored',
      ops: [{ type: 'insert', value: { id: 'm2' } }],
    })
    expect(begin).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('default-subscribe: without injection, falls back to user-stream with effectiveCollection', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const coll = createSyncedCollection<{ id: string }, string>({
      id: 'projects',
      getKey: (r) => r.id,
      queryKey: ['projects'] as const,
      queryFn: async () => [],
      syncFrameType: 'projects',
    }) as unknown as { __opts: { sync: { sync: Function } } }

    driveSync(coll)

    // Default path: user-stream bindings used with the effective collection
    // name (derived from syncFrameType in the absence of `collection`).
    expect(mockSubscribeUserStream).toHaveBeenCalledTimes(1)
    expect(mockSubscribeUserStream).toHaveBeenCalledWith('projects', expect.any(Function))
    expect(mockOnUserStreamReconnect).toHaveBeenCalledTimes(1)
  })

  it('throws when neither `collection` nor `syncFrameType` is provided', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    expect(() =>
      createSyncedCollection<{ id: string }, string>({
        id: 'bad',
        getKey: (r) => r.id,
        queryKey: ['bad'] as const,
        queryFn: async () => [],
        // Neither `collection` nor `syncFrameType` — must throw.
      } as unknown as Parameters<typeof createSyncedCollection>[0]),
    ).toThrow(/collection or syncFrameType required/)
  })

  // Regression: queryCollectionOptions auto-calls refetch() after
  // onInsert/onUpdate/onDelete unless the handler returns {refetch:false}.
  // For cursor-based queryFns (messages-collection) that refetch wipes the
  // collection — the just-inserted optimistic row advances the cursor past
  // itself and the refetch response is empty, so applySuccessfulResult
  // deletes every previously-owned row. createSyncedCollection must wrap
  // these handlers so `{refetch: false}` is always forwarded.
  it('wraps onInsert/onUpdate/onDelete to return {refetch: false} (suppresses post-mutation refetch)', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    const userInsert = vi.fn(async () => undefined)
    const userUpdate = vi.fn(async () => ({ some: 'extra' }))
    const userDelete = vi.fn(async () => undefined)

    createSyncedCollection<{ id: string }, string>({
      id: 'refetch-guard',
      getKey: (r) => r.id,
      queryKey: ['refetch-guard'] as const,
      queryFn: async () => [],
      syncFrameType: 'refetch-guard',
      onInsert: userInsert,
      onUpdate: userUpdate,
      onDelete: userDelete,
    })

    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'refetch-guard',
    )
    const cfg = call![0] as {
      onInsert: (ctx: unknown) => Promise<Record<string, unknown>>
      onUpdate: (ctx: unknown) => Promise<Record<string, unknown>>
      onDelete: (ctx: unknown) => Promise<Record<string, unknown>>
    }

    const insertResult = await cfg.onInsert({ transaction: {} })
    expect(userInsert).toHaveBeenCalledTimes(1)
    expect(insertResult.refetch).toBe(false)

    const updateResult = await cfg.onUpdate({ transaction: {} })
    expect(userUpdate).toHaveBeenCalledTimes(1)
    expect(updateResult.refetch).toBe(false)
    expect(updateResult.some).toBe('extra')

    const deleteResult = await cfg.onDelete({ transaction: {} })
    expect(userDelete).toHaveBeenCalledTimes(1)
    expect(deleteResult.refetch).toBe(false)
  })

  it('omits handler when user did not provide one (no spurious noRefetch wrapping)', async () => {
    const { createSyncedCollection } = await import('./synced-collection')

    createSyncedCollection<{ id: string }, string>({
      id: 'no-handlers',
      getKey: (r) => r.id,
      queryKey: ['no-handlers'] as const,
      queryFn: async () => [],
      syncFrameType: 'no-handlers',
    })

    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'no-handlers',
    )
    const cfg = call![0] as { onInsert?: unknown; onUpdate?: unknown; onDelete?: unknown }
    expect(cfg.onInsert).toBeUndefined()
    expect(cfg.onUpdate).toBeUndefined()
    expect(cfg.onDelete).toBeUndefined()
  })
})
