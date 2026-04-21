/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock TanStackDB modules
const mockInsert = vi.fn()
const mockDelete = vi.fn()
const mockIterator = vi.fn()
const mockCollection = {
  insert: mockInsert,
  delete: mockDelete,
  [Symbol.iterator]: mockIterator,
  utils: {},
}

const mockCreateCollection = vi.fn().mockReturnValue(mockCollection)
const mockQueryCollectionOptions = vi.fn().mockImplementation((config) => ({
  ...config,
  _type: 'queryCollectionOptions',
}))
const mockPersistedCollectionOptions = vi.fn().mockImplementation((config) => ({
  ...config,
  _type: 'persistedCollectionOptions',
}))

vi.mock('@tanstack/db', () => ({
  createCollection: mockCreateCollection,
}))

vi.mock('@tanstack/query-db-collection', () => ({
  queryCollectionOptions: mockQueryCollectionOptions,
}))

vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: mockPersistedCollectionOptions,
}))

vi.mock('./db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { fetchQuery: vi.fn() },
}))

describe('messages-collection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports createMessagesCollection factory', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    expect(mod.createMessagesCollection).toBeDefined()
    expect(typeof mod.createMessagesCollection).toBe('function')
  })

  it('exports legacy messagesCollection singleton stub', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    expect(mod.messagesCollection).toBeDefined()
  })

  it('configures queryCollectionOptions with per-agentName id and getKey', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    mod.createMessagesCollection('test-agent')

    expect(mockQueryCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'messages:test-agent',
        queryKey: ['messages', 'test-agent'],
      }),
    )

    // getKey extracts .id — find the call for 'test-agent'
    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'messages:test-agent',
    )
    expect(call).toBeDefined()
    const config = call![0] as { getKey: (item: { id: string }) => string }
    expect(config.getKey({ id: 'msg-123' })).toBe('msg-123')
  })

  it('creates collection without persistence when persistence is null', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    mod.createMessagesCollection('agent-1')

    expect(mockCreateCollection).toHaveBeenCalled()
    expect(mockPersistedCollectionOptions).not.toHaveBeenCalled()
  })

  it('wraps with persistedCollectionOptions (schemaVersion 5) when persistence is available', async () => {
    vi.resetModules()

    vi.doMock('./db-instance', () => ({
      dbReady: Promise.resolve({ adapter: {}, coordinator: {} }),
      queryClient: { fetchQuery: vi.fn() },
    }))

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('agent-persisted')

    expect(mockPersistedCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 5,
        persistence: expect.objectContaining({ adapter: {} }),
      }),
    )
  })

  it('memoises collections by agentName', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    const a1 = mod.createMessagesCollection('agentA')
    const a2 = mod.createMessagesCollection('agentA')
    const b = mod.createMessagesCollection('agentB')

    expect(a1).toBe(a2)
    // a1 and b come from the same mock but different createCollection calls
    // — assert that createCollection was invoked once per distinct agentName
    // (1 for __legacy__ from module load, 1 for agentA, 1 for agentB).
    const distinctIds = new Set(
      mockQueryCollectionOptions.mock.calls.map((c) => (c[0] as { id: string }).id),
    )
    expect(distinctIds.has('messages:agentA')).toBe(true)
    expect(distinctIds.has('messages:agentB')).toBe(true)
  })

  it('exports CachedMessage type that narrows id to string and adds sessionId', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    // Type check via interface
    const msg: mod.CachedMessage = {
      id: 'msg-1',
      sessionId: 'session-abc',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
      createdAt: '2026-01-01T00:00:00Z',
    }
    expect(msg.id).toBe('msg-1')
    expect(msg.sessionId).toBe('session-abc')
  })
})

describe('createMessagesCollection retry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('configures retry: 1, retryDelay: 500, staleTime: Infinity, refetchInterval: undefined, syncMode: eager', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    mod.createMessagesCollection('retry-agent')

    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'messages:retry-agent',
    )
    expect(call).toBeDefined()
    const config = call![0] as {
      retry: number
      retryDelay: number
      staleTime: number
      refetchInterval: unknown
      syncMode: string
    }
    expect(config.retry).toBe(1)
    expect(config.retryDelay).toBe(500)
    expect(config.staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(config.refetchInterval).toBeUndefined()
    expect(config.syncMode).toBe('eager')
  })

  it('queryFn fetches from the REST /api/sessions/:id/messages endpoint', async () => {
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
    mod.createMessagesCollection('fetch-agent')

    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'messages:fetch-agent',
    )
    expect(call).toBeDefined()
    const config = call![0] as {
      queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown[]>
    }
    const ctrl = new AbortController()
    const rows = (await config.queryFn({ signal: ctrl.signal })) as Array<{
      id: string
      sessionId: string
    }>
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/sessions/fetch-agent/messages',
      expect.objectContaining({ signal: ctrl.signal }),
    )
    expect(rows[0].id).toBe('m1')
    expect(rows[0].sessionId).toBe('fetch-agent')
  })

  it('queryFn stamps each row with seq=version from the REST body (regression: initial-load flash)', async () => {
    // Fix for "user messages grouped together on initial load":
    // query-db-collection's diff reconcile runs `write('update', newItem)`
    // for every key matching an existing row. If REST returns rows without
    // `seq`, any seq-stamped rows the WS snapshot had already written get
    // clobbered. Passing `version` through and stamping each row keeps the
    // sort contract stable.
    vi.resetModules()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 42,
        messages: [
          { id: 'usr-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
        ],
      }),
    })
    // @ts-expect-error — jsdom doesn't ship fetch; assign a minimal stub.
    globalThis.fetch = mockFetch

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('seq-stamp-agent')

    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'messages:seq-stamp-agent',
    )
    const config = call![0] as {
      queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown[]>
    }
    const rows = (await config.queryFn({
      signal: new AbortController().signal,
    })) as Array<{ id: string; seq?: number }>
    expect(rows).toHaveLength(2)
    expect(rows[0].seq).toBe(42)
    expect(rows[1].seq).toBe(42)
  })

  it('queryFn omits seq when the REST body has no version (backcompat)', async () => {
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
    mod.createMessagesCollection('no-version-agent')

    const call = mockQueryCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'messages:no-version-agent',
    )
    const config = call![0] as {
      queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown[]>
    }
    const rows = (await config.queryFn({
      signal: new AbortController().signal,
    })) as Array<{ id: string; seq?: number }>
    expect(rows[0].seq).toBeUndefined()
  })
})

describe('evictOldMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes messages older than 30 days across every cached collection', async () => {
    vi.resetModules()

    const thirtyOneDaysAgo = new Date()
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31)

    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)

    const entries: [string, { id: string; createdAt: string; sessionId: string }][] = [
      [
        'old-1',
        {
          id: 'old-1',
          createdAt: thirtyOneDaysAgo.toISOString(),
          sessionId: 's1',
        },
      ],
      [
        'recent-1',
        {
          id: 'recent-1',
          createdAt: twoDaysAgo.toISOString(),
          sessionId: 's1',
        },
      ],
    ]

    mockIterator.mockReturnValue(entries[Symbol.iterator]())

    const mod = await import('./messages-collection')
    // Ensure at least one cached collection exists.
    mod.createMessagesCollection('evict-agent')
    mod.evictOldMessages()

    expect(mockDelete).toHaveBeenCalledWith(['old-1'])
  })

  it('does not delete when no messages are stale', async () => {
    vi.resetModules()

    const twoDaysAgo = new Date()
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)

    const entries: [string, { id: string; created_at: string; sessionId: string }][] = [
      [
        'recent-1',
        {
          id: 'recent-1',
          created_at: twoDaysAgo.toISOString(),
          sessionId: 's1',
        },
      ],
    ]

    mockIterator.mockReturnValue(entries[Symbol.iterator]())

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('evict-agent')
    mod.evictOldMessages()

    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('handles empty collection gracefully', async () => {
    vi.resetModules()

    mockIterator.mockReturnValue([][Symbol.iterator]())

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('evict-agent')
    mod.evictOldMessages()

    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('handles collection iteration errors gracefully', async () => {
    vi.resetModules()

    mockIterator.mockImplementation(() => {
      throw new Error('Collection not ready')
    })

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('evict-agent')

    // Should not throw
    expect(() => mod.evictOldMessages()).not.toThrow()
  })

  it('skips messages without created_at', async () => {
    vi.resetModules()

    const entries: [string, { id: string; created_at?: string; sessionId: string }][] = [
      ['no-date', { id: 'no-date', sessionId: 's1' }],
    ]

    mockIterator.mockReturnValue(entries[Symbol.iterator]())

    const mod = await import('./messages-collection')
    mod.createMessagesCollection('evict-agent')
    mod.evictOldMessages()

    expect(mockDelete).not.toHaveBeenCalled()
  })
})
