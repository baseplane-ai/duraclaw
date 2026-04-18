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
const mockLocalOnlyCollectionOptions = vi.fn().mockImplementation((config) => ({
  ...config,
  _type: 'localOnlyCollectionOptions',
}))
const mockPersistedCollectionOptions = vi.fn().mockImplementation((config) => ({
  ...config,
  _type: 'persistedCollectionOptions',
}))

vi.mock('@tanstack/db', () => ({
  createCollection: mockCreateCollection,
  localOnlyCollectionOptions: mockLocalOnlyCollectionOptions,
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

  it('exports messagesCollection', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')
    expect(mod.messagesCollection).toBeDefined()
  })

  it('configures localOnlyCollectionOptions with id and getKey', async () => {
    vi.resetModules()
    await import('./messages-collection')

    expect(mockLocalOnlyCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'messages',
      }),
    )

    // getKey should extract .id
    const config = mockLocalOnlyCollectionOptions.mock.calls[0][0]
    expect(config.getKey({ id: 'msg-123', sessionId: 's1' })).toBe('msg-123')
  })

  it('creates collection without persistence when persistence is null', async () => {
    vi.resetModules()
    await import('./messages-collection')

    expect(mockCreateCollection).toHaveBeenCalled()
    expect(mockPersistedCollectionOptions).not.toHaveBeenCalled()
  })

  it('wraps with persistedCollectionOptions when persistence is available', async () => {
    vi.resetModules()

    vi.doMock('./db-instance', () => ({
      dbReady: Promise.resolve({ adapter: {}, coordinator: {} }),
      queryClient: { fetchQuery: vi.fn() },
    }))

    await import('./messages-collection')

    expect(mockPersistedCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        persistence: expect.objectContaining({ adapter: {} }),
      }),
    )
  })

  it('exports CachedMessage type that narrows id to string and adds sessionId', async () => {
    vi.resetModules()
    const mod = await import('./messages-collection')

    // Type check via interface
    const msg: mod.CachedMessage = {
      id: 'msg-1',
      sessionId: 'session-abc',
      role: 'assistant',
      type: 'text',
      content: '{"text":"hello"}',
      event_uuid: 'uuid-1',
      created_at: '2026-01-01T00:00:00Z',
    }
    expect(msg.id).toBe('msg-1')
    expect(msg.sessionId).toBe('session-abc')
  })
})

describe('evictOldMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes messages older than 30 days', async () => {
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
    mod.evictOldMessages()

    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('handles empty collection gracefully', async () => {
    vi.resetModules()

    mockIterator.mockReturnValue([][Symbol.iterator]())

    const mod = await import('./messages-collection')
    mod.evictOldMessages()

    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('handles collection iteration errors gracefully', async () => {
    vi.resetModules()

    mockIterator.mockImplementation(() => {
      throw new Error('Collection not ready')
    })

    const mod = await import('./messages-collection')

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
    mod.evictOldMessages()

    expect(mockDelete).not.toHaveBeenCalled()
  })
})
