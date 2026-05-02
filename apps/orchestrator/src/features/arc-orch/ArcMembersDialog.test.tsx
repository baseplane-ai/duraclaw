/**
 * @vitest-environment jsdom
 *
 * GH#152 P1 — owner vs member render gating + add-member refresh flow
 * for ArcMembersDialog.
 *
 * The component fetches `/api/arcs/:id/members` via global `fetch` and
 * derives the caller's role from whichever member row matches their
 * Better Auth user id. We mock `useAuthSession` to control the caller's
 * id, mock `fetch` to return a canned roster, and assert which controls
 * the DOM ends up with.
 *
 * Sonner's `toast` is stubbed because jsdom can't render its portal in a
 * headless test (the dialog reaches for `document.body` via Radix —
 * which works — but sonner's toaster expects a Toaster mounted in the
 * tree, which we don't mount here).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '~/test-utils'

// Mock the auth-client BEFORE the component import (vi.mock is hoisted
// but the factory still runs at import time).
const mockAuthSession: { data: { user: { id: string } } | null } = {
  data: { user: { id: 'user-owner' } },
}

vi.mock('~/lib/auth-client', () => ({
  useSession: () => mockAuthSession,
}))

vi.mock('~/lib/platform', () => ({
  apiUrl: (p: string) => p,
  apiBaseUrl: () => '',
  isNative: () => false,
  isExpoNative: () => false,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

import { ArcMembersDialog } from './ArcMembersDialog'

interface FetchMock {
  calls: Array<{ url: string; init?: RequestInit }>
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>
}

function installFetch(mock: FetchMock) {
  ;(globalThis as any).fetch = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    mock.calls.push({ url, init })
    return mock.responder(url, init)
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const OWNER_ID = 'user-owner'
const MEMBER_ID = 'user-member'

const OWNER_ROW = {
  userId: OWNER_ID,
  email: 'owner@example.com',
  name: 'Owner',
  role: 'owner' as const,
  addedAt: '2026-04-01T00:00:00Z',
  addedBy: OWNER_ID,
}
const MEMBER_ROW = {
  userId: MEMBER_ID,
  email: 'member@example.com',
  name: 'Member',
  role: 'member' as const,
  addedAt: '2026-04-15T00:00:00Z',
  addedBy: OWNER_ID,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockAuthSession.data = { user: { id: OWNER_ID } }
})

describe('ArcMembersDialog (GH#152 P1) — role-gated render', () => {
  beforeEach(() => {
    mockAuthSession.data = { user: { id: OWNER_ID } }
  })

  it("owner sees the add-member input + per-row 'Remove' control", async () => {
    const mock: FetchMock = {
      calls: [],
      responder: () => jsonResponse({ members: [OWNER_ROW, MEMBER_ROW], invitations: [] }),
    }
    installFetch(mock)

    render(<ArcMembersDialog arcId="arc-1" arcTitle="Test Arc" open={true} onClose={() => {}} />)

    // Wait for the loaded state — the placeholder "Loading…" text
    // disappears once the fetch resolves.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('teammate@example.com')).toBeTruthy()
    })

    // Owner-only add input present.
    expect(screen.getByLabelText('Invite by email')).toBeTruthy()
    // Add-member button present.
    expect(screen.getByRole('button', { name: 'Add member' })).toBeTruthy()
    // Per-row Remove buttons (one per member).
    const removeButtons = screen.queryAllByRole('button', { name: /^Remove / })
    expect(removeButtons.length).toBeGreaterThanOrEqual(2)
  })

  it('non-owner member does NOT see add-member input or remove controls', async () => {
    mockAuthSession.data = { user: { id: MEMBER_ID } }
    const mock: FetchMock = {
      calls: [],
      responder: () => jsonResponse({ members: [OWNER_ROW, MEMBER_ROW], invitations: [] }),
    }
    installFetch(mock)

    render(<ArcMembersDialog arcId="arc-1" arcTitle="Test Arc" open={true} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText(/You are a member of this arc/)).toBeTruthy()
    })

    // No add-member input.
    expect(screen.queryByPlaceholderText('teammate@example.com')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull()
    // No Remove buttons.
    expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0)
  })
})

describe('ArcMembersDialog — adding a member triggers a refetch', () => {
  beforeEach(() => {
    mockAuthSession.data = { user: { id: OWNER_ID } }
  })

  it('after a successful POST, the GET endpoint is hit again and the new row appears', async () => {
    const NEW_MEMBER = {
      userId: 'user-new',
      email: 'new@example.com',
      name: 'New Member',
      role: 'member' as const,
      addedAt: '2026-05-01T00:00:00Z',
      addedBy: OWNER_ID,
    }
    let getCount = 0
    const mock: FetchMock = {
      calls: [],
      responder: (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'GET' && url.includes('/members')) {
          getCount++
          if (getCount === 1) {
            return jsonResponse({ members: [OWNER_ROW], invitations: [] })
          }
          return jsonResponse({ members: [OWNER_ROW, NEW_MEMBER], invitations: [] })
        }
        if (method === 'POST' && url.endsWith('/members')) {
          return jsonResponse({ kind: 'added', member: NEW_MEMBER })
        }
        return jsonResponse({ error: 'unhandled' }, 500)
      },
    }
    installFetch(mock)

    render(<ArcMembersDialog arcId="arc-1" arcTitle="Test Arc" open={true} onClose={() => {}} />)

    // Initial fetch resolves and we are owner.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('teammate@example.com')).toBeTruthy()
    })
    expect(getCount).toBe(1)

    // Type the new email and submit.
    const input = screen.getByLabelText('Invite by email') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'new@example.com' } })
    })
    const submit = screen.getByRole('button', { name: 'Add member' })
    await act(async () => {
      fireEvent.click(submit)
    })

    // Second GET (refresh) should fire after the POST resolves.
    await waitFor(() => {
      expect(getCount).toBe(2)
    })

    // The new member's email shows up in the dialog body once the
    // refresh resolves.
    await waitFor(() => {
      expect(screen.queryByText('New Member')).toBeTruthy()
    })

    // POST went to the right URL with the right body.
    const postCall = mock.calls.find((c) => (c.init?.method ?? 'GET') === 'POST')
    expect(postCall).toBeTruthy()
    expect(postCall?.url).toContain('/api/arcs/arc-1/members')
    expect(postCall?.init?.body).toBe(JSON.stringify({ email: 'new@example.com' }))
  })
})
