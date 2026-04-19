/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock TanStackDB modules
const mockCollection = {
  insert: vi.fn(),
  update: vi.fn(),
  has: vi.fn(),
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
}))

describe('branch-info-collection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports createBranchInfoCollection factory', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    expect(mod.createBranchInfoCollection).toBeDefined()
    expect(typeof mod.createBranchInfoCollection).toBe('function')
  })

  it('configures localOnlyCollectionOptions with per-agentName id and getKey on parentMsgId', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')

    mod.createBranchInfoCollection('agent-a')

    expect(mockLocalOnlyCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'branch_info:agent-a' }),
    )

    const call = mockLocalOnlyCollectionOptions.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'branch_info:agent-a',
    )
    expect(call).toBeDefined()
    const config = call![0] as { getKey: (row: { parentMsgId: string }) => string }
    expect(config.getKey({ parentMsgId: 'usr-1' })).toBe('usr-1')
  })

  it('creates collection without persistence when dbReady resolves to null', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('agent-unpersisted')

    expect(mockCreateCollection).toHaveBeenCalled()
    expect(mockPersistedCollectionOptions).not.toHaveBeenCalled()
  })

  it('wraps with persistedCollectionOptions (schemaVersion 1) when persistence is available', async () => {
    vi.resetModules()

    vi.doMock('./db-instance', () => ({
      dbReady: Promise.resolve({ adapter: {}, coordinator: {} }),
    }))

    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('agent-persisted')

    expect(mockPersistedCollectionOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        persistence: expect.objectContaining({ adapter: {} }),
      }),
    )
  })

  it('memoises collections by agentName', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')

    const a1 = mod.createBranchInfoCollection('agentA')
    const a2 = mod.createBranchInfoCollection('agentA')
    const b = mod.createBranchInfoCollection('agentB')

    expect(a1).toBe(a2)
    expect(a1).toBe(b) // same mock reference, but distinct ids were configured
    const distinctIds = new Set(
      mockLocalOnlyCollectionOptions.mock.calls.map((c) => (c[0] as { id: string }).id),
    )
    expect(distinctIds.has('branch_info:agentA')).toBe(true)
    expect(distinctIds.has('branch_info:agentB')).toBe(true)
  })

  it('exports BranchInfoRow interface shape', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const row: mod.BranchInfoRow = {
      parentMsgId: 'msg-0',
      sessionId: 'session-abc',
      siblings: ['usr-1', 'usr-3'],
      activeId: 'usr-1',
      updatedAt: '2026-04-19T00:00:00Z',
    }
    expect(row.parentMsgId).toBe('msg-0')
    expect(row.siblings).toHaveLength(2)
  })
})
