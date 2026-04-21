import { createRootRoute, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { OfflineBanner } from '~/components/offline-banner'
import { Toaster } from '~/components/ui/sonner'
import { ThemeProvider } from '~/context/theme-provider'
import { setUserStreamIdentity } from '~/hooks/use-user-stream'
import { useSession } from '~/lib/auth-client'
import '~/styles.css'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  const location = useLocation()
  const navigate = useNavigate()
  const { data: session, isPending } = useSession()
  const isLogin = location.pathname === '/login'
  const userId = (session as { user?: { id?: string } } | undefined)?.user?.id ?? null

  // Bind the singleton user-stream WS to the authenticated identity. Null
  // userId (signed out) closes the socket; switching userIds re-opens
  // against the new room. GH#32 replaces the prior useInvalidationChannel.
  //
  // No cleanup fn: the effect's own re-run (userId change) calls
  // setUserStreamIdentity with the new value, which handles A→B via
  // closeSocket+openSocket and A→null via closeSocket. A cleanup that
  // unconditionally called setUserStreamIdentity(null) tore the shared
  // singleton down on every Root re-render (StrictMode double-invoke,
  // useSession re-resolve, fast-refresh) — partysocket's close() sets
  // _shouldReconnect=false (see bf5548e), so any synced-collection
  // subscriber was silently cut off from deltas until the next identity
  // flip. The natural unmount flow (page close / full navigation) lets
  // the browser tear down the socket on its own.
  useEffect(() => {
    setUserStreamIdentity(userId)
  }, [userId])

  useEffect(() => {
    if (isPending) return

    if (!session && !isLogin) {
      navigate({ to: '/login', replace: true })
    }

    if (session && isLogin) {
      navigate({ to: '/', search: {}, replace: true })
    }
  }, [isLogin, isPending, navigate, session])

  if (isPending && !isLogin) {
    return (
      <ThemeProvider>
        <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
          Loading session…
        </div>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <OfflineBanner />
      <Outlet />
      <Toaster duration={5000} />
    </ThemeProvider>
  )
}
