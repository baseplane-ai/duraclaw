/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---

// Shared state that vi.mock factories can reference via dynamic import.
// Data rows carry the SessionSummary shape backing sessionsCollection.
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

// Stub the persistence plumbing so the collection module loads without
// touching OPFS in the test env.
vi.mock('@tanstack/browser-db-sqlite-persistence', () => ({
  persistedCollectionOptions: vi.fn((opts: unknown) => opts),
}))

vi.mock('~/db/db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { invalidateQueries: vi.fn() },
}))

const { mockSessionsCollection } = vi.hoisted(() => {
  return {
    mockSessionsCollection: {
      insert: vi.fn(),
      update: vi.fn(),
      has: vi.fn().mockReturnValue(true),
    },
  }
})

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: mockSessionsCollection,
}))

vi.mock('~/hooks/use-notification-watcher', () => ({
  useNotificationWatcher: vi.fn(),
}))

// Import after mocks
import { useSessionsCollection } from './use-sessions-collection'

function makeSummaryRow(overrides: Record<string, unknown> = {}) {
  // Spec #37 P2a SessionSummary shape — TEXT-typed JSON columns are on the
  // row; top-level summary fields mirror the D1 `agent_sessions` table.
  return {
    id: 's1',
    userId: null,
    project: 'proj',
    status: 'idle',
    model: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastActivity: null,
    durationMs: null,
    totalCostUsd: null,
    numTurns: 0,
    prompt: undefined,
    summary: undefined,
    title: null,
    archived: false,
    origin: null,
    agent: null,
    sdkSessionId: null,
    contextUsageJson: null,
    kataStateJson: null,
    worktreeInfoJson: null,
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
      makeSummaryRow({ id: 's1', archived: false }),
      makeSummaryRow({ id: 's2', archived: true }),
      makeSummaryRow({ id: 's3', archived: false }),
    ]

    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions).toHaveLength(2)
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1', 's3'])
  })

  it('includes archived sessions when includeArchived is true', () => {
    mockLiveQueryData = [
      makeSummaryRow({ id: 's1', archived: false }),
      makeSummaryRow({ id: 's2', archived: true }),
      makeSummaryRow({ id: 's3', archived: false }),
    ]

    const { result } = renderHook(() => useSessionsCollection({ includeArchived: true }))

    expect(result.current.sessions).toHaveLength(3)
    const ids = result.current.sessions.map((s) => s.id).sort()
    expect(ids).toEqual(['s1', 's2', 's3'])
  })

  it('sorts sessions by updatedAt desc', () => {
    mockLiveQueryData = [
      makeSummaryRow({ id: 'old', updatedAt: '2026-01-01T00:00:00Z' }),
      makeSummaryRow({ id: 'new', updatedAt: '2026-01-03T00:00:00Z' }),
      makeSummaryRow({ id: 'mid', updatedAt: '2026-01-02T00:00:00Z' }),
    ]

    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })

  // Regression guard for the sidebar-thrash bug: sub-5s differences in
  // `lastActivity` must NOT reorder the list. Any two rows whose
  // `lastActivity` falls in the same 5-second bucket fall back to
  // `createdAt` DESC (then `id` ASC) — a stable, frame-invariant order.
  // Without bucketing, concurrent agent turns leap-frog the "Recent" list
  // as each turn stamps a fresh millisecond timestamp.
  it('buckets sub-5s lastActivity differences and tiebreaks by createdAt desc', () => {
    mockLiveQueryData = [
      // Both within the same 5s bucket. 'older-created' is ~9s older in
      // createdAt; 'newer-created' was created later. Even though
      // 'older-created' has a later lastActivity (later in the same
      // bucket), it should NOT leap-frog 'newer-created'.
      makeSummaryRow({
        id: 'older-created',
        createdAt: '2026-01-01T00:00:00Z',
        lastActivity: '2026-01-10T12:00:04.900Z',
        updatedAt: '2026-01-10T12:00:04.900Z',
      }),
      makeSummaryRow({
        id: 'newer-created',
        createdAt: '2026-01-05T00:00:00Z',
        lastActivity: '2026-01-10T12:00:00.100Z',
        updatedAt: '2026-01-10T12:00:00.100Z',
      }),
    ]

    const { result } = renderHook(() => useSessionsCollection())
    // newer-created must stay on top: same activity bucket → createdAt
    // tiebreak picks the more recently created session.
    expect(result.current.sessions.map((s) => s.id)).toEqual(['newer-created', 'older-created'])
  })

  // Reorder still happens when activity crosses a 5s bucket boundary.
  it('does reorder when lastActivity crosses a 5s bucket boundary', () => {
    mockLiveQueryData = [
      makeSummaryRow({
        id: 'stale',
        createdAt: '2026-01-05T00:00:00Z',
        lastActivity: '2026-01-10T12:00:00.000Z', // bucket = 12:00:00
        updatedAt: '2026-01-10T12:00:00.000Z',
      }),
      makeSummaryRow({
        id: 'fresh',
        createdAt: '2026-01-01T00:00:00Z', // created earlier
        lastActivity: '2026-01-10T12:00:06.000Z', // bucket = 12:00:05 (one bucket newer)
        updatedAt: '2026-01-10T12:00:06.000Z',
      }),
    ]

    const { result } = renderHook(() => useSessionsCollection())
    expect(result.current.sessions.map((s) => s.id)).toEqual(['fresh', 'stale'])
  })

  it('returns empty array when data is undefined', () => {
    mockLiveQueryData = undefined
    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions).toEqual([])
  })

  describe('createSession', () => {
    it('optimistically inserts into sessionsCollection and POSTs to server', async () => {
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

      // Optimistic insert hits sessionsCollection with the SessionSummary shape.
      expect(mockSessionsCollection.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'new-id',
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
        credentials: 'include',
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
    it('updates the sessionsCollection row and PATCHes server', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.updateSession('s1', { title: 'New Title' })
      })

      // Collection update path fires when row exists (mock has() returns true)
      expect(mockSessionsCollection.update).toHaveBeenCalledWith('s1', expect.any(Function))

      // Should have PATCHed server
      expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
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

      expect(mockSessionsCollection.update).toHaveBeenCalledWith('s1', expect.any(Function))

      // Should send integer to D1
      expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
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
        credentials: 'include',
        body: JSON.stringify({ archived: 0 }),
      })
    })
  })
})
