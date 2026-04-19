/**
 * @vitest-environment jsdom
 *
 * Tests for SessionCardList — mobile card layout for session list.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '~/db/agent-sessions-collection'

// Mock TanStack Router
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

// Mock workspace store
let mockWorkspaceProjects: string[] | null = null
const mockStoreState = () => ({
  activeWorkspace: null,
  workspaceProjects: mockWorkspaceProjects,
  setWorkspace: vi.fn(),
})
vi.mock('~/stores/workspace', () => ({
  useWorkspaceStore: (selector?: (s: ReturnType<typeof mockStoreState>) => unknown) => {
    const state = mockStoreState()
    return selector ? selector(state) : state
  },
}))

// Mock ScrollArea to pass through children
vi.mock('~/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="scroll-area" {...props}>
      {children}
    </div>
  ),
}))

// Mock Badge
vi.mock('~/components/ui/badge', () => ({
  Badge: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <span data-testid="badge" {...props}>
      {children}
    </span>
  ),
}))

// Mock DropdownMenu components used by FilterChipBar
vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))

// Mock fetch for WorkspaceChip
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }))

// Mock ActiveStrip (no-op for card list tests)
vi.mock('./ActiveStrip', () => ({
  ActiveStrip: () => null,
}))

// Mock @react-spring/web — render a plain div
vi.mock('@react-spring/web', () => ({
  animated: {
    div: ({
      children,
      style: _style,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
  },
  useSpring: () => [{ x: 0 }, { start: vi.fn() }],
}))

// Mock @use-gesture/react — simulate tap behavior on click
vi.mock('@use-gesture/react', () => ({
  useDrag: (handler: (state: Record<string, unknown>) => void) => {
    return () => ({
      onClick: () =>
        handler({
          movement: [0, 0],
          velocity: [0, 0],
          active: false,
          tap: true,
          direction: [0, 0],
        }),
    })
  },
}))

// Import after mocks
import { SessionCardList } from './SessionCardList'

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    userId: 'user-1',
    project: 'test-project',
    status: 'idle',
    model: 'claude-sonnet-4-20250514',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  mockNavigate.mockClear()
  mockWorkspaceProjects = null
})

describe('SessionCardList', () => {
  it('renders empty state when no sessions', () => {
    render(<SessionCardList sessions={[]} selectedSessionId={null} onSelectSession={vi.fn()} />)
    expect(screen.getByText('No sessions yet')).toBeTruthy()
  })

  it('renders filter empty state when sessions exist but all filtered', () => {
    const sessions = [makeSession({ archived: true })]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    expect(screen.getByText('No sessions match your filters')).toBeTruthy()
  })

  it('renders session cards with title', () => {
    const sessions = [makeSession({ title: 'My Session' })]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    expect(screen.getByText('My Session')).toBeTruthy()
  })

  it('uses truncated ID when no title', () => {
    const sessions = [makeSession({ id: 'abcdef123456789', title: undefined })]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    // SessionCardList truncates untitled sessions to 8-char IDs.
    expect(screen.getByText('abcdef12')).toBeTruthy()
  })

  it('calls onSelectSession on card click', () => {
    const onSelect = vi.fn()
    const sessions = [makeSession({ id: 'sess-click', title: 'Clickable' })]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={onSelect} />,
    )
    fireEvent.click(screen.getByText('Clickable'))
    expect(onSelect).toHaveBeenCalledWith('sess-click')
    // Navigation is driven by the parent route via onSelectSession; SessionCardList
    // itself does not call useNavigate.
  })

  it('highlights the selected session card', () => {
    const sessions = [makeSession({ id: 'sess-sel', title: 'Selected' })]
    render(
      <SessionCardList
        sessions={sessions}
        selectedSessionId="sess-sel"
        onSelectSession={vi.fn()}
      />,
    )
    const card = screen.getByText('Selected').closest('[data-session-card]')
    expect(card?.className).toContain('border-primary')
  })

  it('filters out archived sessions', () => {
    const sessions = [
      makeSession({ id: 's1', title: 'Active', archived: false }),
      makeSession({ id: 's2', title: 'Archived', archived: true }),
    ]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.queryByText('Archived')).toBeNull()
  })

  it('filters by workspace projects when set', () => {
    mockWorkspaceProjects = ['proj-a']
    const sessions = [
      makeSession({ id: 's1', project: 'proj-a', title: 'In Workspace' }),
      makeSession({ id: 's2', project: 'proj-b', title: 'Outside Workspace' }),
    ]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    expect(screen.getByText('In Workspace')).toBeTruthy()
    expect(screen.queryByText('Outside Workspace')).toBeNull()
  })

  it('renders kata badge when kata_mode is present', () => {
    const sessions = [
      makeSession({
        id: 's1',
        title: 'Kata Session',
        kataMode: 'implementation',
        kataIssue: 29,
        kataPhase: 'p1',
      }),
    ]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    expect(screen.getByText('implementation #29 P1')).toBeTruthy()
  })

  it('does not render kata badge when kata_mode is absent', () => {
    const sessions = [makeSession({ id: 's1', title: 'No Kata' })]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    // Filter chip badges exist, but no kata badge text should appear
    const badges = screen.queryAllByTestId('badge')
    const kataBadges = badges.filter((b) => b.closest('[data-session-card]') !== null)
    expect(kataBadges).toHaveLength(0)
  })

  it('groups sessions by date', () => {
    const now = new Date()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const sessions = [
      makeSession({ id: 's1', title: 'Today Session', createdAt: now.toISOString() }),
      makeSession({
        id: 's2',
        title: 'Yesterday Session',
        createdAt: yesterday.toISOString(),
      }),
    ]
    render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    // Both sessions should be visible (within default this-week range)
    expect(screen.getByText('Today Session')).toBeTruthy()
    expect(screen.getByText('Yesterday Session')).toBeTruthy()
    // Group headings exist (may have duplicates from filter chip dropdowns, so use getAllByText)
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Yesterday').length).toBeGreaterThan(0)
  })

  it('renders session cards with data-session-card attribute', () => {
    const sessions = [makeSession({ title: 'Card Test' })]
    const { container } = render(
      <SessionCardList sessions={sessions} selectedSessionId={null} onSelectSession={vi.fn()} />,
    )
    expect(container.querySelector('[data-session-card]')).toBeTruthy()
  })
})
