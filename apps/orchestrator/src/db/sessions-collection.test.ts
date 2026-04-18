/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'

// `sessions-collection.ts` is a re-export shim around
// `agent-sessions-collection.ts`. Since the new module top-level-awaits
// `dbReady`, we mock both `db-instance` and the persistence helpers.

vi.mock('@tanstack/db', () => ({
  createCollection: vi.fn().mockReturnValue({
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    utils: { refetch: vi.fn() },
  }),
}))

vi.mock('@tanstack/query-db-collection', () => ({
  queryCollectionOptions: vi.fn().mockImplementation((c) => c),
}))

vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: vi.fn().mockImplementation((c) => c),
}))

vi.mock('./db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { fetchQuery: vi.fn() },
}))

describe('sessions-collection (re-export shim)', () => {
  it('re-exports sessionsCollection from agent-sessions-collection', async () => {
    const shim = await import('./sessions-collection')
    const real = await import('./agent-sessions-collection')
    expect(shim.sessionsCollection).toBe(real.agentSessionsCollection)
  })
})

describe('agent-sessions-collection queryFn', () => {
  it('fetches /api/sessions and coerces archived to boolean', async () => {
    vi.resetModules()

    vi.doMock('./db-instance', () => ({
      dbReady: Promise.resolve(null),
      queryClient: { fetchQuery: vi.fn() },
    }))

    const queryOpts = vi.fn().mockImplementation((c) => c)
    vi.doMock('@tanstack/query-db-collection', () => ({
      queryCollectionOptions: queryOpts,
    }))

    vi.doMock('@tanstack/db', () => ({
      createCollection: vi.fn().mockReturnValue({}),
    }))

    vi.doMock('@tanstack/browser-db-sqlite-persistence', () => ({
      persistedCollectionOptions: vi.fn().mockImplementation((c) => c),
    }))

    const serverData = {
      sessions: [{ id: 's1', archived: 1 }, { id: 's2', archived: 0 }, { id: 's3' }],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(serverData), { status: 200 }),
    )

    await import('./agent-sessions-collection')
    const cfg = queryOpts.mock.calls[0][0]
    const result = await cfg.queryFn()
    expect(result).toHaveLength(3)
    expect(result[0].archived).toBe(true)
    expect(result[1].archived).toBe(false)
    expect(result[2].archived).toBe(false)
  })
})
