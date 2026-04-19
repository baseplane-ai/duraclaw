/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---

// Shared state that vi.mock factories can reference via dynamic import.
// SessionLiveState rows carry top-level SessionSummary fields after GH#14 B8.
let mockLiveQueryData: Array<Record<string, unknown>> | undefined = []
let mockLiveQueryIsLoading = false

vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({
    get data() {
      return mockLiveQueryData
    },
    get isLoading() {
      return mockLiveQueryIsLoading
    },
  }),
}))

vi.mock('@tanstack/db', () => ({
  createTransaction: vi.fn().mockImplementation(({ mutationFn }) => ({
    mutate: (fn: () => void) => {
      fn()
      mutationFn()
    },
    isPersisted: { promise: Promise.resolve() },
  })),
  localOnlyCollectionOptions: vi.fn(() => ({})),
  createCollection: vi.fn(() => ({
    insert: vi.fn(),
    update: vi.fn(),
    has: vi.fn().mockReturnValue(true),
  })),
}))

// Stub the persistence plumbing so the live-state-collection module loads
// without touching OPFS in the test env.
vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: vi.fn((opts: unknown) => opts),
}))

vi.mock('~/db/db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { invalidateQueries: vi.fn() },
}))

const { mockUpsert, mockLiveStateCollection } = vi.hoisted(() => {
  return {
    mockUpsert: vi.fn(),
    mockLiveStateCollection: {
      insert: vi.fn(),
      update: vi.fn(),
      has: vi.fn().mockReturnValue(true),
    },
  }
})

vi.mock('~/db/session-live-state-collection', () => ({
  sessionLiveStateCollection: mockLiveStateCollection,
  upsertSessionLiveState: mockUpsert,
}))

vi.mock('~/hooks/use-notification-watcher', () => ({
  useNotificationWatcher: vi.fn(),
}))

// Import after mocks
import { useSessionsCollection } from './use-sessions-collection'

function makeLiveStateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    state: null,
    contextUsage: null,
    kataState: null,
    worktreeInfo: null,
    sessionResult: null,
    wsReadyState: 3,
    updatedAt: '2026-01-01T00:00:00Z',
    // Top-level SessionSummary fields (schema v2)
    userId: null,
    project: 'proj',
    model: null,
    createdAt: '2026-01-01T00:00:00Z',
    archived: false,
    status: 'idle',
    ...overrides,
  }
}

describe('useSessionsCollection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLiveQueryData = []
    mockLiveQueryIsLoading = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty sessions array when data is empty', () => {
    mockLiveQueryData = []
    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('returns isLoading from useLiveQuery', () => {
    mockLiveQueryIsLoading = true
    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.isLoading).toBe(true)
  })

  it('filters out archived sessions by default', () => {
    mockLiveQueryData = [
      makeLiveStateRow({ id: 's1', archived: false }),
      makeLiveStateRow({ id: 's2', archived: true }),
      makeLiveStateRow({ id: 's3', archived: false }),
    ]

    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions).toHaveLength(2)
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1', 's3'])
  })

  it('includes archived sessions when includeArchived is true', () => {
    mockLiveQueryData = [
      makeLiveStateRow({ id: 's1', archived: false }),
      makeLiveStateRow({ id: 's2', archived: true }),
      makeLiveStateRow({ id: 's3', archived: false }),
    ]

    const { result } = renderHook(() => useSessionsCollection({ includeArchived: true }))

    expect(result.current.sessions).toHaveLength(3)
    const ids = result.current.sessions.map((s) => s.id).sort()
    expect(ids).toEqual(['s1', 's2', 's3'])
  })

  it('sorts sessions by updatedAt desc', () => {
    mockLiveQueryData = [
      makeLiveStateRow({ id: 'old', updatedAt: '2026-01-01T00:00:00Z' }),
      makeLiveStateRow({ id: 'new', updatedAt: '2026-01-03T00:00:00Z' }),
      makeLiveStateRow({ id: 'mid', updatedAt: '2026-01-02T00:00:00Z' }),
    ]

    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })

  it('returns empty array when data is undefined', () => {
    mockLiveQueryData = undefined
    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions).toEqual([])
  })

  describe('createSession', () => {
    it('upserts live-state row and POSTs to server', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.createSession({
          id: 'new-id',
          project: 'my-proj',
          model: 'claude-opus-4-6',
          prompt: 'do stuff',
        })
      })

      // Should have upserted into the live-state collection with optimistic fields
      expect(mockUpsert).toHaveBeenCalledWith(
        'new-id',
        expect.objectContaining({
          project: 'my-proj',
          model: 'claude-opus-4-6',
          prompt: 'do stuff',
          status: 'idle',
          archived: false,
        }),
      )

      // Should have POSTed to server
      expect(fetch).toHaveBeenCalledWith('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'new-id',
          project: 'my-proj',
          model: 'claude-opus-4-6',
          prompt: 'do stuff',
        }),
      })
    })
  })

  describe('updateSession', () => {
    it('updates live-state row and PATCHes server', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.updateSession('s1', { title: 'New Title' })
      })

      // Collection update path fires when row exists (mock has() returns true)
      expect(mockLiveStateCollection.update).toHaveBeenCalledWith('s1', expect.any(Function))

      // Should have PATCHed server
      expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Title' }),
      })
    })
  })

  describe('archiveSession', () => {
    it('updates archived in collection and sends integer to server', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.archiveSession('s1', true)
      })

      expect(mockLiveStateCollection.update).toHaveBeenCalledWith('s1', expect.any(Function))

      // Should send integer to D1
      expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: 1 }),
      })
    })

    it('sends 0 when unarchiving', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.archiveSession('s1', false)
      })

      expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: 0 }),
      })
    })
  })

  describe('refresh', () => {
    it('is a no-op (sessionLiveStateCollection is localOnly)', async () => {
      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.refresh()
      })

      // No refetch exists on localOnlyCollection — just a stable resolved promise.
      // Assert we can call it without throwing.
      expect(true).toBe(true)
    })
  })
})
