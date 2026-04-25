/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────

// Mock TanStack Router
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({ component: undefined }),
}))

// Mock layout wrappers to passthrough children
vi.mock('~/components/layout/header', () => ({
  Header: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header">{children}</div>
  ),
}))
vi.mock('~/components/layout/main', () => ({
  Main: ({ children }: { children: React.ReactNode }) => <div data-testid="main">{children}</div>,
}))

// Mock auth-client — non-admin by default so the ProjectsSection renders null
// and doesn't disturb the existing section-structure assertions. The admin
// case gets its own describe block below.
const mockSignOut = vi.fn(() => Promise.resolve())
let mockAuthSessionReturn: {
  data: { user: { role?: string } } | null
  error: null
  isPending: boolean
} = {
  data: { user: { role: 'user' } },
  error: null,
  isPending: false,
}
vi.mock('~/lib/auth-client', () => ({
  signOut: () => mockSignOut(),
  useSession: () => mockAuthSessionReturn,
}))

// Mock platform apiUrl
vi.mock('~/lib/platform', () => ({
  apiUrl: (p: string) => p,
  isNative: () => false,
}))

// Mock projectsCollection — the live query just needs to resolve; in the
// non-admin default case ProjectsSection returns null before subscribing.
vi.mock('~/db/projects-collection', () => ({
  projectsCollection: {},
}))

const mockLiveQueryData: { current: unknown[] } = { current: [] }
vi.mock('@tanstack/react-db', () => ({
  useLiveQuery: () => ({ data: mockLiveQueryData.current }),
}))

// Mock useUserDefaults
const mockUpdatePreferences = vi.fn()
let mockUserDefaultsReturn = {
  preferences: {
    permissionMode: 'default',
    model: 'claude-opus-4-6',
    maxBudget: null as number | null,
    thinkingMode: 'adaptive',
    effort: 'high',
  },
  updatePreferences: mockUpdatePreferences,
  loading: false,
}
vi.mock('~/hooks/use-user-defaults', () => ({
  useUserDefaults: () => mockUserDefaultsReturn,
}))

// Mock NotificationPreferences
vi.mock('~/components/notification-preferences', () => ({
  NotificationPreferences: () => (
    <div data-testid="notification-preferences">NotificationPrefs</div>
  ),
}))

// Mock theme provider
const mockSetTheme = vi.fn()
let mockThemeReturn = {
  theme: 'system' as string,
  setTheme: mockSetTheme,
  defaultTheme: 'system',
  resolvedTheme: 'light' as const,
  resetTheme: vi.fn(),
}
vi.mock('~/context/theme-provider', () => ({
  useTheme: () => mockThemeReturn,
}))

// Mock layout provider
const mockSetVariant = vi.fn()
let mockLayoutReturn = {
  variant: 'inset' as string,
  setVariant: mockSetVariant,
  defaultVariant: 'inset',
  collapsible: 'icon' as const,
  setCollapsible: vi.fn(),
  defaultCollapsible: 'icon' as const,
  resetLayout: vi.fn(),
}
vi.mock('~/context/layout-provider', () => ({
  useLayout: () => mockLayoutReturn,
}))

// We cannot import the Route export and extract the component easily,
// so we import the file and test the individual section functions.
// Since they are not exported, we'll re-import the module and render sections
// by rendering the whole page.

// The SettingsPage is not exported directly, but it's set as the route component.
// We'll access it by importing the module and manually getting the component.
// Actually, let's just import the whole module and test via the page structure.

// Helper: We need to get SettingsPage. Since createFileRoute is mocked,
// we need a different approach. Let's re-mock createFileRoute to capture the component.
let CapturedComponent: React.ComponentType | null = null
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => {
    CapturedComponent = opts.component
    return opts
  },
}))

// Force re-import to capture
await import('./settings')

describe('SettingsPage', () => {
  beforeEach(() => {
    mockSignOut.mockClear()
    mockUpdatePreferences.mockClear()
    mockSetTheme.mockClear()
    mockSetVariant.mockClear()
    mockUserDefaultsReturn = {
      preferences: {
        permissionMode: 'default',
        model: 'claude-opus-4-6',
        maxBudget: null,
        thinkingMode: 'adaptive',
        effort: 'high',
      },
      updatePreferences: mockUpdatePreferences,
      loading: false,
    }
    mockThemeReturn = {
      theme: 'system',
      setTheme: mockSetTheme,
      defaultTheme: 'system',
      resolvedTheme: 'light',
      resetTheme: vi.fn(),
    }
    mockLayoutReturn = {
      variant: 'inset',
      setVariant: mockSetVariant,
      defaultVariant: 'inset',
      collapsible: 'icon',
      setCollapsible: vi.fn(),
      defaultCollapsible: 'icon',
      resetLayout: vi.fn(),
    }
  })

  afterEach(() => {
    cleanup()
  })

  function renderPage() {
    if (!CapturedComponent) throw new Error('SettingsPage component not captured')
    return render(<CapturedComponent />)
  }

  // ── Page structure ────────────────────────────────────────────────

  it('renders all four section headings', () => {
    renderPage()
    expect(screen.getByText('Account')).toBeDefined()
    expect(screen.getByText('Defaults')).toBeDefined()
    expect(screen.getByText('Notifications')).toBeDefined()
    expect(screen.getByText('Appearance')).toBeDefined()
  })

  it('renders the page title in the header', () => {
    renderPage()
    expect(screen.getByText('Settings')).toBeDefined()
  })

  // ── Account section ───────────────────────────────────────────────

  it('renders the Sign Out button', () => {
    renderPage()
    expect(screen.getByRole('button', { name: 'Sign Out' })).toBeDefined()
  })

  it('calls signOut when Sign Out is clicked', async () => {
    mockSignOut.mockReturnValue(new Promise(() => {})) // never resolves
    renderPage()
    const btn = screen.getByRole('button', { name: 'Sign Out' })

    await act(async () => {
      btn.click()
    })

    expect(mockSignOut).toHaveBeenCalledOnce()
  })

  // ── Defaults section ──────────────────────────────────────────────

  it('shows loading state when preferences are loading', () => {
    mockUserDefaultsReturn.loading = true
    renderPage()
    expect(screen.getByText('Loading preferences...')).toBeDefined()
  })

  it('renders all permission mode radio options', () => {
    renderPage()
    expect(screen.getByText('Default')).toBeDefined()
    expect(screen.getByText('Accept Edits')).toBeDefined()
    expect(screen.getByText('Bypass')).toBeDefined()
    expect(screen.getByText('Plan')).toBeDefined()
    expect(screen.getByText("Don't Ask")).toBeDefined()
    expect(screen.getByText('Auto')).toBeDefined()
  })

  it('renders permission mode descriptions', () => {
    renderPage()
    expect(screen.getByText('Ask for permission on risky actions')).toBeDefined()
    expect(screen.getByText('Auto-accept file edits')).toBeDefined()
    expect(screen.getByText('Skip all permission prompts')).toBeDefined()
    expect(screen.getByText('Plan only, no execution')).toBeDefined()
    expect(screen.getByText('Never ask questions')).toBeDefined()
    expect(screen.getByText('Fully autonomous mode')).toBeDefined()
  })

  it('calls updatePreferences when a permission mode radio is clicked', async () => {
    renderPage()
    const planRadio = screen.getByLabelText('Plan')

    await act(async () => {
      planRadio.click()
    })

    expect(mockUpdatePreferences).toHaveBeenCalledWith({ permissionMode: 'plan' })
  })

  it('renders the Max Budget input with placeholder', () => {
    renderPage()
    const input = screen.getByLabelText('Max Budget (USD)')
    expect(input).toBeDefined()
    expect(input.getAttribute('placeholder')).toBe('No limit')
    expect(input.getAttribute('type')).toBe('number')
  })

  it('calls updatePreferences with null when budget is cleared', async () => {
    mockUserDefaultsReturn.preferences.maxBudget = 10
    renderPage()
    const input = screen.getByLabelText('Max Budget (USD)') as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { value: '' } })
    })

    expect(mockUpdatePreferences).toHaveBeenCalledWith({ maxBudget: null })
  })

  it('calls updatePreferences with parsed number when budget is set', async () => {
    renderPage()
    const input = screen.getByLabelText('Max Budget (USD)') as HTMLInputElement

    await act(async () => {
      fireEvent.change(input, { target: { value: '25.5' } })
    })

    expect(mockUpdatePreferences).toHaveBeenCalledWith({ maxBudget: 25.5 })
  })

  it('renders Model label', () => {
    renderPage()
    expect(screen.getByText('Model')).toBeDefined()
  })

  it('renders Thinking Mode label', () => {
    renderPage()
    expect(screen.getByText('Thinking Mode')).toBeDefined()
  })

  it('renders Effort label', () => {
    renderPage()
    expect(screen.getByText('Effort')).toBeDefined()
  })

  // ── Notifications section ─────────────────────────────────────────

  it('embeds the NotificationPreferences component', () => {
    renderPage()
    expect(screen.getByTestId('notification-preferences')).toBeDefined()
  })

  it('renders notification section description', () => {
    renderPage()
    expect(screen.getByText('Configure which events trigger push notifications.')).toBeDefined()
  })

  // ── Appearance section ────────────────────────────────────────────

  it('renders Theme label', () => {
    renderPage()
    expect(screen.getByText('Theme')).toBeDefined()
  })

  it('renders Sidebar Variant label', () => {
    renderPage()
    expect(screen.getByText('Sidebar Variant')).toBeDefined()
  })

  it('renders section descriptions', () => {
    renderPage()
    expect(screen.getByText('Manage your account settings.')).toBeDefined()
    expect(
      screen.getByText('Default values for new sessions. These can be overridden per session.'),
    ).toBeDefined()
    expect(screen.getByText('Customize the look and feel of the application.')).toBeDefined()
  })

  // ── Projects section (admin-gated) ───────────────────────────────

  it('hides the Projects section for non-admin users', () => {
    mockAuthSessionReturn = {
      data: { user: { role: 'user' } },
      error: null,
      isPending: false,
    }
    renderPage()
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('shows the Projects section for admin users with a per-project toggle', () => {
    mockAuthSessionReturn = {
      data: { user: { role: 'admin' } },
      error: null,
      isPending: false,
    }
    mockLiveQueryData.current = [
      {
        name: 'alpha',
        path: '/a',
        branch: 'main',
        dirty: false,
        active_session: null,
        repo_origin: null,
        ahead: 0,
        behind: 0,
        pr: null,
        visibility: 'public',
      },
      {
        name: 'beta',
        path: '/b',
        branch: 'main',
        dirty: false,
        active_session: null,
        repo_origin: null,
        ahead: 0,
        behind: 0,
        pr: null,
        visibility: 'private',
      },
    ]
    renderPage()
    expect(screen.getByText('Projects')).toBeDefined()
    expect(screen.getByText('alpha')).toBeDefined()
    expect(screen.getByText('beta')).toBeDefined()
    // Toggle labels reflect current state — public projects offer "Make private"
    expect(screen.getByRole('button', { name: 'Make private' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Make public' })).toBeDefined()
  })

  it('PATCHes the visibility endpoint when the admin clicks a toggle', async () => {
    mockAuthSessionReturn = {
      data: { user: { role: 'admin' } },
      error: null,
      isPending: false,
    }
    mockLiveQueryData.current = [
      {
        name: 'alpha',
        path: '/a',
        branch: 'main',
        dirty: false,
        active_session: null,
        repo_origin: null,
        ahead: 0,
        behind: 0,
        pr: null,
        visibility: 'public',
      },
    ]

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, visibility: 'private' })))

    renderPage()
    const btn = screen.getByRole('button', { name: 'Make private' })
    await act(async () => {
      fireEvent.click(btn)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/alpha/visibility',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ visibility: 'private' }),
      }),
    )
    fetchMock.mockRestore()
  })
})
