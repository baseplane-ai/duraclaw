/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---

// Shared state that vi.mock factories can reference via dynamic import
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
}))

vi.mock('~/db/sessions-collection', () => ({
  sessionsCollection: {
    insert: vi.fn(),
    update: vi.fn(),
    utils: { refetch: vi.fn().mockResolvedValue([]) },
  },
}))

vi.mock('~/hooks/use-notification-watcher', () => ({
  useNotificationWatcher: vi.fn(),
}))

import { sessionsCollection } from '~/db/sessions-collection'
// Import after mocks
import { useSessionsCollection } from './use-sessions-collection'

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    userId: null,
    project: 'proj',
    status: 'idle',
    model: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    archived: false,
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

  it('filters out archived sessions', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', archived: false }),
      makeSession({ id: 's2', archived: true }),
      makeSession({ id: 's3', archived: false }),
    ]

    const { result } = renderHook(() => useSessionsCollection())

    expect(result.current.sessions).toHaveLength(2)
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1', 's3'])
  })

  it('sorts sessions by updated_at desc', () => {
    mockLiveQueryData = [
      makeSession({ id: 'old', updated_at: '2026-01-01T00:00:00Z' }),
      makeSession({ id: 'new', updated_at: '2026-01-03T00:00:00Z' }),
      makeSession({ id: 'mid', updated_at: '2026-01-02T00:00:00Z' }),
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
    it('inserts optimistic record and POSTs to server', async () => {
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

      // Should have called insert with optimistic record
      expect(sessionsCollection.insert).toHaveBeenCalledWith(
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
    it('updates collection and PATCHes server', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.updateSession('s1', { title: 'New Title' })
      })

      // Should have called update on collection
      expect(sessionsCollection.update).toHaveBeenCalledWith('s1', expect.any(Function))

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

      // Should have called update on collection
      expect(sessionsCollection.update).toHaveBeenCalledWith('s1', expect.any(Function))

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
    it('calls collection refetch', async () => {
      const { result } = renderHook(() => useSessionsCollection())

      await act(async () => {
        await result.current.refresh()
      })

      expect(sessionsCollection.utils.refetch).toHaveBeenCalled()
    })
  })
})
