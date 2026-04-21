/**
 * @vitest-environment jsdom
 *
 * SessionHistory tests -- verifies TanStackDB-backed client-side
 * sort/filter/search and resume button behavior.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '~/db/session-record'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

// Mock useSessionsCollection to return controlled data — SessionHistory
// now reads through the shared hook after GH#14 P5.
let mockLiveQueryData: SessionRecord[] | null = null
let mockLiveQueryIsLoading = false

vi.mock('~/hooks/use-sessions-collection', () => ({
  useSessionsCollection: () => ({
    sessions: mockLiveQueryData ?? [],
    isLoading: mockLiveQueryIsLoading,
    createSession: vi.fn(),
    updateSession: vi.fn(),
    archiveSession: vi.fn(),
  }),
}))

// Must import after mocks
const { SessionHistory } = await import('./SessionHistory')

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    userId: 'user-1',
    project: 'test-project',
    status: 'idle',
    model: 'claude-sonnet-4-20250514',
    createdAt: '2026-04-10T00:00:00Z',
    updatedAt: '2026-04-10T01:00:00Z',
    archived: false,
    ...overrides,
  }
}

function makeDiscoveredSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeSession({
    id: 'discovered-1',
    sdkSessionId: 'sdk-abc-123',
    agent: 'claude',
    origin: 'discovered',
    ...overrides,
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockNavigate.mockReset()
  mockLiveQueryData = null
  mockLiveQueryIsLoading = false
})

describe('SessionHistory loading and empty states', () => {
  it('shows Loading when isLoading is true and no data', () => {
    mockLiveQueryIsLoading = true
    mockLiveQueryData = null
    render(<SessionHistory />)
    expect(screen.getByText('Loading...')).toBeTruthy()
  })

  it('shows "No sessions found" when data is empty', () => {
    mockLiveQueryData = []
    render(<SessionHistory />)
    expect(screen.getByText('No sessions found')).toBeTruthy()
  })

  it('renders session rows when data is present', () => {
    mockLiveQueryData = [makeSession({ title: 'My Session' })]
    render(<SessionHistory />)
    expect(screen.getByText('My Session')).toBeTruthy()
    expect(screen.getByTestId('history-row')).toBeTruthy()
  })
})

describe('SessionHistory client-side filtering', () => {
  it('filters by status', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', title: 'Running One', status: 'running' }),
      makeSession({ id: 's2', title: 'Idle One', status: 'idle' }),
      makeSession({ id: 's3', title: 'Failed One', status: 'failed' }),
    ]
    render(<SessionHistory />)

    // All three visible initially
    expect(screen.getByText('Running One')).toBeTruthy()
    expect(screen.getByText('Idle One')).toBeTruthy()
    expect(screen.getByText('Failed One')).toBeTruthy()

    // Select "Running" status filter
    const trigger = screen.getByTestId('history-status-filter')
    fireEvent.click(trigger)
    const runningOption = screen.getByText('Running')
    fireEvent.click(runningOption)

    // Only running session visible
    expect(screen.getByText('Running One')).toBeTruthy()
    expect(screen.queryByText('Idle One')).toBeNull()
    expect(screen.queryByText('Failed One')).toBeNull()
  })

  it('filters by search query matching title', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', title: 'Deploy feature' }),
      makeSession({ id: 's2', title: 'Fix bug' }),
    ]
    render(<SessionHistory />)

    const searchInput = screen.getByTestId('history-search')
    fireEvent.change(searchInput, { target: { value: 'deploy' } })

    expect(screen.getByText('Deploy feature')).toBeTruthy()
    expect(screen.queryByText('Fix bug')).toBeNull()
  })

  it('filters by search query matching prompt', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', title: 'Session A', prompt: 'add tests for auth' }),
      makeSession({ id: 's2', title: 'Session B', prompt: 'refactor database' }),
    ]
    render(<SessionHistory />)

    const searchInput = screen.getByTestId('history-search')
    fireEvent.change(searchInput, { target: { value: 'auth' } })

    expect(screen.getByText('Session A')).toBeTruthy()
    expect(screen.queryByText('Session B')).toBeNull()
  })

  it('filters by search query matching summary', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', title: 'Session A', summary: 'Added new middleware' }),
      makeSession({ id: 's2', title: 'Session B', summary: 'Updated schema' }),
    ]
    render(<SessionHistory />)

    const searchInput = screen.getByTestId('history-search')
    fireEvent.change(searchInput, { target: { value: 'middleware' } })

    expect(screen.getByText('Session A')).toBeTruthy()
    expect(screen.queryByText('Session B')).toBeNull()
  })

  it('search is case-insensitive', () => {
    mockLiveQueryData = [makeSession({ id: 's1', title: 'Deploy Feature' })]
    render(<SessionHistory />)

    const searchInput = screen.getByTestId('history-search')
    fireEvent.change(searchInput, { target: { value: 'DEPLOY' } })

    expect(screen.getByText('Deploy Feature')).toBeTruthy()
  })

  it('does not filter out archived sessions', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', title: 'Active', archived: false }),
      makeSession({ id: 's2', title: 'Archived', archived: true }),
    ]
    render(<SessionHistory />)

    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Archived')).toBeTruthy()
  })
})

describe('SessionHistory client-side sorting', () => {
  it('sorts by created_at when column header is clicked', () => {
    mockLiveQueryData = [
      makeSession({
        id: 's1',
        title: 'Older',
        createdAt: '2026-04-08T00:00:00Z',
        updatedAt: '2026-04-08T00:00:00Z',
      }),
      makeSession({
        id: 's2',
        title: 'Newer',
        createdAt: '2026-04-10T00:00:00Z',
        updatedAt: '2026-04-10T00:00:00Z',
      }),
    ]
    render(<SessionHistory />)

    // Default sort is updated_at desc, so Newer first
    const rows = screen.getAllByTestId('history-row')
    expect(rows[0].textContent).toContain('Newer')

    // Click "Created" header to sort by created_at desc
    fireEvent.click(screen.getByText('Created'))

    const rowsAfter = screen.getAllByTestId('history-row')
    expect(rowsAfter[0].textContent).toContain('Newer')

    // Click again to toggle to asc
    fireEvent.click(screen.getByText('Created'))
    const rowsAsc = screen.getAllByTestId('history-row')
    expect(rowsAsc[0].textContent).toContain('Older')
  })

  it('sorts by cost when column header is clicked', () => {
    mockLiveQueryData = [
      makeSession({
        id: 's1',
        title: 'Cheap',
        totalCostUsd: 0.5,
        updatedAt: '2026-04-10T00:00:00Z',
      }),
      makeSession({
        id: 's2',
        title: 'Expensive',
        totalCostUsd: 5.0,
        updatedAt: '2026-04-10T00:00:00Z',
      }),
    ]
    render(<SessionHistory />)

    // Click "Cost" to sort desc
    fireEvent.click(screen.getByText('Cost'))
    const rows = screen.getAllByTestId('history-row')
    expect(rows[0].textContent).toContain('Expensive')
    expect(rows[1].textContent).toContain('Cheap')
  })

  it('sorts by num_turns when column header is clicked', () => {
    mockLiveQueryData = [
      makeSession({
        id: 's1',
        title: 'Few Turns',
        numTurns: 3,
        updatedAt: '2026-04-10T00:00:00Z',
      }),
      makeSession({
        id: 's2',
        title: 'Many Turns',
        numTurns: 50,
        updatedAt: '2026-04-10T00:00:00Z',
      }),
    ]
    render(<SessionHistory />)

    fireEvent.click(screen.getByText('Turns'))
    const rows = screen.getAllByTestId('history-row')
    expect(rows[0].textContent).toContain('Many Turns')
    expect(rows[1].textContent).toContain('Few Turns')
  })
})

describe('SessionHistory project list derivation', () => {
  it('derives projects from all sessions, not filtered results', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', project: 'proj-a', status: 'running', title: 'A' }),
      makeSession({ id: 's2', project: 'proj-b', status: 'idle', title: 'B' }),
    ]
    render(<SessionHistory />)

    // Both projects exist so project filter should be visible
    expect(screen.getByTestId('history-project-filter')).toBeTruthy()

    // Now filter by status=running (only proj-a session matches)
    const statusTrigger = screen.getByTestId('history-status-filter')
    fireEvent.click(statusTrigger)
    fireEvent.click(screen.getByText('Running'))

    // Project filter should still be visible (derived from all sessions)
    expect(screen.getByTestId('history-project-filter')).toBeTruthy()
  })

  it('hides project filter when only one project exists', () => {
    mockLiveQueryData = [
      makeSession({ id: 's1', project: 'only-project', title: 'A' }),
      makeSession({ id: 's2', project: 'only-project', title: 'B' }),
    ]
    render(<SessionHistory />)

    expect(screen.queryByTestId('history-project-filter')).toBeNull()
  })
})

describe('SessionHistory Resume button', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('shows Resume button for discovered sessions with sdk_session_id', () => {
    mockLiveQueryData = [makeDiscoveredSession()]
    render(<SessionHistory />)
    expect(screen.getByText('Resume')).toBeTruthy()
  })

  it('does not show Resume button for non-discovered sessions', () => {
    mockLiveQueryData = [makeSession({ agent: 'claude' })]
    render(<SessionHistory />)
    expect(screen.getByTestId('history-row')).toBeTruthy()
    expect(screen.queryByText('Resume')).toBeNull()
  })

  it('calls POST /api/sessions with sdk_session_id when Resume is clicked', async () => {
    mockLiveQueryData = [makeDiscoveredSession()]
    render(<SessionHistory />)

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ session_id: 'new-session-id' }),
    })

    fireEvent.click(screen.getByText('Resume'))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (call: unknown[]) => call[0] === '/api/sessions' && call[1]?.method === 'POST',
      )
      expect(postCall).toBeDefined()

      const body = JSON.parse(postCall?.[1].body as string)
      expect(body.project).toBe('test-project')
      expect(body.prompt).toBe('resume')
      expect(body.sdk_session_id).toBe('sdk-abc-123')
      expect(body.agent).toBe('claude')
    })
  })

  it('navigates to the new session after successful resume', async () => {
    mockLiveQueryData = [makeDiscoveredSession()]
    render(<SessionHistory />)

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ session_id: 'new-session-id' }),
    })

    fireEvent.click(screen.getByText('Resume'))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/',
        search: { session: 'new-session-id' },
      })
    })
  })

  it('does not navigate when POST /api/sessions fails', async () => {
    mockLiveQueryData = [makeDiscoveredSession()]
    render(<SessionHistory />)

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal error' }),
    })

    fireEvent.click(screen.getByText('Resume'))

    // Give time for the async handler to run
    await new Promise((r) => setTimeout(r, 50))

    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
