import { createRootRoute, HeadContent, Outlet, redirect, Scripts, useLocation } from '@tanstack/react-router'
import { useState } from 'react'
import { getSession } from '~/lib/auth.functions'
import { ProjectSidebar } from '~/lib/components/project-sidebar'
import '~/styles.css'

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Skip auth check on the login page to avoid redirect loops
    if (location.pathname === '/login') {
      return
    }

    try {
      const session = await getSession()
      if (!session) {
        throw redirect({ to: '/login' })
      }
      return { session }
    } catch (err) {
      // If auth check fails (e.g. env not configured), redirect to login
      if (err && typeof err === 'object' && 'to' in err) throw err // re-throw redirects
      throw redirect({ to: '/login' })
    }
  },
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

  function toggleCollapse() {
    const next = !collapsed
    setCollapsed(next)
    if (isBrowser) browserGlobal.localStorage?.setItem('sidebar-collapsed', String(next))
  }

  return (
    <div className="flex h-screen">
      <ProjectSidebar collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      <div className="relative flex-1 overflow-auto">
        {collapsed && (
          <button
            type="button"
            onClick={toggleCollapse}
            className="absolute left-3 top-3 z-10 rounded-md border border-border bg-card p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Open sidebar"
          >
            {'\u2630'}
          </button>
        )}
        {children}
      </div>
    </div>
  )
}

function RootComponent() {
  // Use TanStack Router's useLocation for SSR-safe pathname detection.
  // This produces consistent output on both server and client, avoiding
  // hydration mismatches that caused the sidebar to disappear.
  const location = useLocation()
  const isLogin = location.pathname === '/login'

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Duraclaw Orchestrator</title>
        <HeadContent />
      </head>
      <body>
        {isLogin ? (
          <Outlet />
        ) : (
          <AppLayout>
            <Outlet />
          </AppLayout>
        )}
        <Scripts />
      </body>
    </html>
  )
}
