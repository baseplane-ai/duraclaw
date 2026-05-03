/**
 * @vitest-environment jsdom
 *
 * GH#152 P1.5 WU-E — MentionsList component tests.
 *
 * Mocks the data-loading layer (`use-arc-mentions` + `arcs-collection`)
 * via mutable shared state — same shape as `TeamChatPanel.test.tsx`.
 * The TanStack Router `Link` is replaced with a plain `<a href>` so the
 * test can assert href targets without spinning up a real router. Sonner
 * is stubbed because jsdom can't render its portal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArcMentionRow } from '~/db/arc-mentions-collection'
import type { ArcSummary } from '~/lib/types'
import { act, cleanup, fireEvent, render, screen, within } from '~/test-utils'

// ── Shared mock state, mutated per-test before render ─────────────────

const mockState: {
  mentions: ArcMentionRow[]
  arcs: ArcSummary[]
  markRead: ReturnType<typeof vi.fn>
  markAllRead: ReturnType<typeof vi.fn>
} = {
  mentions: [],
  arcs: [],
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}

vi.mock('~/features/arc-orch/use-arc-mentions', () => ({
  useInboxMentions: () => mockState.mentions,
  useInboxActions: () => ({
    markRead: mockState.markRead,
    markAllRead: mockState.markAllRead,
  }),
}))

// `arcsCollection` is consumed via `useLiveQuery(arcsCollection)`. We
// mock the whole react-db hook to return our `arcs` fixture; the
// `arcsCollection` import only needs to resolve to anything truthy
// (the value is forwarded as the hook arg, which we ignore).
vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({ data: mockState.arcs }),
}))

vi.mock('~/db/arcs-collection', () => ({
  arcsCollection: { __mock: 'arcs' },
}))

// Replace TanStack Router's `Link` with a plain anchor so the test can
// assert href targets without instantiating a router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    className,
    title,
  }: {
    to: string
    params?: Record<string, string>
    children: React.ReactNode
    className?: string
    title?: string
  }) => {
    let href = to
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        href = href.replace(`$${k}`, v)
      }
    }
    return (
      <a href={href} className={className} title={title}>
        {children}
      </a>
    )
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { MentionsList } from './MentionsList'

function mention(overrides: Partial<ArcMentionRow> = {}): ArcMentionRow {
  return {
    id: 'mention-1',
    userId: 'user-me',
    arcId: 'arc-1',
    sourceKind: 'comment',
    sourceId: 'cmt-1',
    actorUserId: 'user-actor',
    preview: 'hey @me check this out',
    mentionTs: new Date(Date.now() - 5 * 60_000).toISOString(),
    readAt: null,
    ...overrides,
  }
}

function arc(overrides: Partial<ArcSummary> = {}): ArcSummary {
  return {
    id: 'arc-1',
    title: 'Test Arc',
    status: 'open',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  } as ArcSummary
}

beforeEach(() => {
  mockState.mentions = []
  mockState.arcs = []
  mockState.markRead = vi.fn().mockResolvedValue({ ok: true })
  mockState.markAllRead = vi.fn().mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
})

describe('MentionsList — empty state', () => {
  it("default Unread filter on empty list shows the 'No mentions yet' fallback", () => {
    mockState.mentions = []
    render(<MentionsList />)
    // On a fully empty list the filter is Unread (default) but
    // `mentions.length === 0`, so the impl shows 'No mentions yet'.
    expect(screen.getByTestId('inbox-empty').textContent).toContain('No mentions yet')
  })

  it("Unread filter with all-read mentions shows 'All caught up!'", () => {
    mockState.mentions = [
      mention({ id: 'm-1', readAt: '2026-04-30T00:00:00Z' }),
      mention({ id: 'm-2', readAt: '2026-04-30T00:00:00Z' }),
    ]
    render(<MentionsList />)
    // Unread filter (default) hides the read rows → empty + non-empty
    // mentions.length triggers the 'All caught up!' branch.
    expect(screen.getByTestId('inbox-empty').textContent).toContain('All caught up!')
  })

  it("All filter on a totally empty list shows 'No mentions yet'", async () => {
    mockState.mentions = []
    render(<MentionsList />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbox-filter-all'))
    })
    expect(screen.getByTestId('inbox-empty').textContent).toContain('No mentions yet')
  })
})

describe('MentionsList — render shape', () => {
  it('renders 3 unread mention rows with actor, arc title, preview, relative time', () => {
    mockState.arcs = [arc({ id: 'arc-1', title: 'My Arc Title' })]
    mockState.mentions = [
      mention({
        id: 'm-1',
        actorUserId: 'alice',
        arcId: 'arc-1',
        preview: 'first ping',
        mentionTs: new Date(Date.now() - 2 * 60_000).toISOString(),
        readAt: null,
      }),
      mention({
        id: 'm-2',
        actorUserId: 'bob',
        arcId: 'arc-1',
        preview: 'second ping',
        mentionTs: new Date(Date.now() - 30 * 60_000).toISOString(),
        readAt: null,
      }),
      mention({
        id: 'm-3',
        actorUserId: 'carol',
        arcId: 'arc-1',
        preview: 'third ping',
        mentionTs: new Date(Date.now() - 60 * 60_000).toISOString(),
        readAt: null,
      }),
    ]
    render(<MentionsList />)

    const rows = screen.getAllByTestId('inbox-mention-row')
    expect(rows).toHaveLength(3)

    expect(within(rows[0]).getByText('alice')).toBeTruthy()
    expect(within(rows[0]).getByText('first ping')).toBeTruthy()
    // Arc title is resolved via the arcsCollection lookup.
    const titleLinks = within(rows[0]).getAllByText('My Arc Title')
    expect(titleLinks.length).toBeGreaterThan(0)
    // Relative-time string ('2m ago' / '30m ago' / '1h ago' depending on
    // bucket boundaries).
    expect(within(rows[0]).getByText(/m ago|h ago|just now/)).toBeTruthy()

    expect(within(rows[1]).getByText('bob')).toBeTruthy()
    expect(within(rows[2]).getByText('carol')).toBeTruthy()
  })

  it('toggling Unread → All shows both unread and read mentions together', async () => {
    mockState.arcs = [arc({ id: 'arc-1', title: 'Arc' })]
    mockState.mentions = [
      mention({ id: 'unread-1', preview: 'unread copy', readAt: null }),
      mention({ id: 'read-1', preview: 'read copy', readAt: '2026-04-30T00:00:00Z' }),
    ]
    render(<MentionsList />)

    // Unread (default) hides the read row.
    expect(screen.getByText('unread copy')).toBeTruthy()
    expect(screen.queryByText('read copy')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('inbox-filter-all'))
    })

    expect(screen.getByText('unread copy')).toBeTruthy()
    expect(screen.getByText('read copy')).toBeTruthy()
  })
})

describe('MentionsList — actions', () => {
  it('per-row Mark-read button calls markRead({mentionId})', async () => {
    mockState.arcs = [arc({ id: 'arc-1', title: 'Arc' })]
    mockState.mentions = [mention({ id: 'mention-X', readAt: null })]
    render(<MentionsList />)

    const btn = screen.getByTestId('inbox-mark-read')
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(mockState.markRead).toHaveBeenCalledTimes(1)
    expect(mockState.markRead).toHaveBeenCalledWith('mention-X')
  })

  it('header Mark-all-read button calls markAllRead() when unread > 0', async () => {
    mockState.arcs = [arc({ id: 'arc-1', title: 'Arc' })]
    mockState.mentions = [mention({ id: 'a', readAt: null }), mention({ id: 'b', readAt: null })]
    render(<MentionsList />)

    const allBtn = screen.getByTestId('inbox-mark-all-read')
    await act(async () => {
      fireEvent.click(allBtn)
    })

    expect(mockState.markAllRead).toHaveBeenCalledTimes(1)
  })

  it('header Mark-all-read button is hidden when unread count = 0', () => {
    mockState.arcs = [arc({ id: 'arc-1', title: 'Arc' })]
    mockState.mentions = [
      mention({ id: 'a', readAt: '2026-04-30T00:00:00Z' }),
      mention({ id: 'b', readAt: '2026-04-30T00:00:00Z' }),
    ]
    render(<MentionsList />)

    expect(screen.queryByTestId('inbox-mark-all-read')).toBeNull()
  })
})

describe('MentionsList — navigation', () => {
  it('renders an arc link with href /arc/<arcId> on each row', () => {
    mockState.arcs = [arc({ id: 'arc-XYZ', title: 'Some Arc' })]
    mockState.mentions = [
      mention({ id: 'm-1', arcId: 'arc-XYZ', preview: 'click me', readAt: null }),
    ]
    render(<MentionsList />)

    const row = screen.getByTestId('inbox-mention-row')
    const links = within(row).getAllByRole('link')
    // Both the arc-title link and the preview link target the arc route.
    expect(links.length).toBeGreaterThanOrEqual(2)
    for (const a of links) {
      expect(a.getAttribute('href')).toBe('/arc/arc-XYZ')
    }
  })
})
