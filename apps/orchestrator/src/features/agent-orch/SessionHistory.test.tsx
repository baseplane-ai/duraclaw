/**
 * @vitest-environment jsdom
 *
 * SessionHistory tests -- verifies resume button calls POST /api/sessions
 * with sdk_session_id for discovered sessions.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '~/lib/types'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

// Must import after mocks
const { SessionHistory } = await import('./SessionHistory')

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    userId: 'user-1',
    project: 'test-project',
    status: 'idle',
    model: 'claude-sonnet-4-20250514',
    created_at: '2026-04-10T00:00:00Z',
    updated_at: '2026-04-10T01:00:00Z',
    ...overrides,
  }
}

function makeDiscoveredSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return makeSession({
    id: 'discovered-1',
    sdk_session_id: 'sdk-abc-123',
    agent: 'claude',
    origin: 'discovered',
    ...overrides,
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockNavigate.mockReset()
})

describe('SessionHistory Resume button', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('shows Resume button for discovered sessions with sdk_session_id', async () => {
    const discoveredSession = makeDiscoveredSession()

    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [discoveredSession],
          total: 1,
        }),
    })

    render(<SessionHistory />)

    await waitFor(() => {
      expect(screen.getByText('Resume')).toBeTruthy()
    })
  })

  it('does not show Resume button for non-discovered sessions', async () => {
    const regularSession = makeSession({ agent: 'claude' })

    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [regularSession],
          total: 1,
        }),
    })

    render(<SessionHistory />)

    await waitFor(() => {
      expect(screen.getByTestId('history-row')).toBeTruthy()
    })

    expect(screen.queryByText('Resume')).toBeNull()
  })

  it('calls POST /api/sessions with sdk_session_id when Resume is clicked', async () => {
    const discoveredSession = makeDiscoveredSession()

    // First call: history fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [discoveredSession],
          total: 1,
        }),
    })

    render(<SessionHistory />)

    await waitFor(() => {
      expect(screen.getByText('Resume')).toBeTruthy()
    })

    // Setup mock for the POST /api/sessions call
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ session_id: 'new-session-id' }),
    })

    fireEvent.click(screen.getByText('Resume'))

    await waitFor(() => {
      // Find the POST call (not the initial GET history fetch)
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
    const discoveredSession = makeDiscoveredSession()

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [discoveredSession],
          total: 1,
        }),
    })

    render(<SessionHistory />)

    await waitFor(() => {
      expect(screen.getByText('Resume')).toBeTruthy()
    })

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
    const discoveredSession = makeDiscoveredSession()

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          sessions: [discoveredSession],
          total: 1,
        }),
    })

    render(<SessionHistory />)

    await waitFor(() => {
      expect(screen.getByText('Resume')).toBeTruthy()
    })

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
