/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the TanStackDB modules to test our configuration logic
const mockCreateCollection = vi.fn().mockReturnValue({
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  utils: { refetch: vi.fn() },
})
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
  persistence: null,
  queryClient: { fetchQuery: vi.fn() },
}))

describe('sessions-collection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports sessionsCollection', async () => {
    vi.resetModules()
    const mod = await import('./sessions-collection')
    expect(mod.sessionsCollection).toBeDefined()
  })

  it('configures queryCollectionOptions with correct parameters', async () => {
    vi.resetModules()
    await import('./sessions-collection')

    expect(mockQueryCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['sessions'],
        refetchInterval: 30_000,
        staleTime: 15_000,
      }),
    )

    // getKey should extract .id
    const config = mockQueryCollectionOptions.mock.calls[0][0]
    expect(config.getKey({ id: 'test-123' })).toBe('test-123')
  })

  it('creates collection without persistence when persistence is null', async () => {
    vi.resetModules()
    await import('./sessions-collection')

    // Should call createCollection but NOT persistedCollectionOptions
    expect(mockCreateCollection).toHaveBeenCalled()
    expect(mockPersistedCollectionOptions).not.toHaveBeenCalled()
  })

  it('wraps with persistedCollectionOptions when persistence is available', async () => {
    vi.resetModules()

    // Override db-instance mock to provide persistence
    vi.doMock('./db-instance', () => ({
      persistence: { adapter: {}, coordinator: {} },
      queryClient: { fetchQuery: vi.fn() },
    }))

    await import('./sessions-collection')

    expect(mockPersistedCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        persistence: expect.objectContaining({ adapter: {} }),
      }),
    )
  })

  it('exports SessionRecord type extending SessionSummary with archived', async () => {
    vi.resetModules()
    const mod = await import('./sessions-collection')

    // Type check via interface -- ensure SessionRecord has archived field
    const record: mod.SessionRecord = {
      id: 'test',
      userId: null,
      project: 'proj',
      status: 'idle',
      model: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      archived: false,
    }
    expect(record.archived).toBe(false)
  })
})

describe('sessions-collection queryFn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches from /api/sessions and coerces archived to boolean', async () => {
    vi.resetModules()

    const serverData = {
      sessions: [
        {
          id: 's1',
          userId: null,
          project: 'proj',
          status: 'idle',
          model: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          archived: 1,
        },
        {
          id: 's2',
          userId: null,
          project: 'proj',
          status: 'running',
          model: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
          archived: 0,
        },
        {
          id: 's3',
          userId: null,
          project: 'proj',
          status: 'idle',
          model: null,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        },
      ],
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(serverData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await import('./sessions-collection')

    // Extract the queryFn from the call
    const config = mockQueryCollectionOptions.mock.calls[0][0]
    const result = await config.queryFn()

    expect(fetch).toHaveBeenCalledWith('/api/sessions')
    expect(result).toHaveLength(3)
    expect(result[0].archived).toBe(true)
    expect(result[1].archived).toBe(false)
    expect(result[2].archived).toBe(false)
  })
})
