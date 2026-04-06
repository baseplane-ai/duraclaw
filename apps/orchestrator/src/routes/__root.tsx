import { createRootRoute, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useSession } from '~/lib/auth-client'
import { BottomTabs } from '~/lib/components/bottom-tabs'
import { ProjectSidebar } from '~/lib/components/project-sidebar'
import '~/styles.css'

export const Route = createRootRoute({
  component: RootComponent,
})

type BrowserGlobal = typeof globalThis & {
  window?: unknown
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }
}

const browserGlobal = globalThis as BrowserGlobal
const isBrowser = typeof browserGlobal.window !== 'undefined'

function AppLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (!isBrowser) return false
    return browserGlobal.localStorage?.getItem('sidebar-collapsed') === 'true'
  })
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  function toggleCollapse() {
    const next = !collapsed
    setCollapsed(next)
    if (isBrowser) browserGlobal.localStorage?.setItem('sidebar-collapsed', String(next))
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-48 bg-[radial-gradient(circle_at_top,_rgba(250,250,250,0.08),_transparent_60%)]" />
      <div className="relative z-10 flex min-h-dvh">
        <ProjectSidebar
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          mobileOpen={mobileSidebarOpen}
          onMobileOpenChange={setMobileSidebarOpen}
        />
        <div className="relative min-w-0 flex-1 overflow-x-clip">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            className="fixed left-4 top-4 z-30 inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-card/95 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-foreground lg:hidden"
            data-testid="mobile-menu-button"
            title="Open sessions"
          >
            {'\u2630'}
          </button>
          {collapsed && (
            <button
              type="button"
              onClick={toggleCollapse}
              className="absolute left-3 top-3 z-10 hidden min-h-11 min-w-11 items-center justify-center rounded-xl border border-border bg-card/95 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-foreground lg:inline-flex"
              data-testid="desktop-sidebar-open"
              title="Open sidebar"
            >
              {'\u2630'}
            </button>
          )}
          <div className="min-h-dvh min-w-0 pb-20 sm:pb-0">{children}</div>
          <BottomTabs
            pathname={location.pathname}
            onNavigate={(to) => {
              setMobileSidebarOpen(false)
              navigate({ to })
            }}
            onOpenSessions={() => setMobileSidebarOpen(true)}
          />
        </div>
      </div>
    </div>
  )
}

function RootComponent() {
  const location = useLocation()
  const navigate = useNavigate()
  const { data: session, isPending } = useSession()
  const isLogin = location.pathname === '/login'

  useEffect(() => {
    if (isPending) {
      return
    }

    if (!session && !isLogin) {
      navigate({ to: '/login', replace: true })
    }

    if (session && isLogin) {
      navigate({ to: '/', replace: true })
    }
  }, [isLogin, isPending, navigate, session])

  if (isLogin) {
    return <Outlet />
  }

  if (isPending || !session) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6 text-sm text-muted-foreground">
        Loading session…
      </div>
    )
  }

  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  )
}
