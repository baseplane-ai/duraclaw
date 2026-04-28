import { TamaguiProvider, Theme } from '@tamagui/core'
import { createRootRoute, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { TamaguiHello } from '~/components/tamagui-hello'
import { Toaster } from '~/components/ui/sonner'
import { ThemeProvider, useTheme } from '~/context/theme-provider'
import { setUserStreamIdentity } from '~/hooks/use-user-stream'
import { useSession } from '~/lib/auth-client'
import { connectionManager } from '~/lib/connection-manager/manager'
import { NowProvider } from '~/lib/use-now'
import { tamaguiConfig } from '~/tamagui.config'
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

  // GH#42: start the ConnectionManager once at app-shell mount. It
  // subscribes to lifecycleEventSource (visibility / online / offline
  // on web; Capacitor App + Network on native) and fires staggered
  // reconnects across every registered WS on `foreground` / `online`.
  // The old `useAppLifecycle` hook is gone; per-session hydrate now
  // rides on the agent adapter's `open` event inside use-coding-agent.
  useEffect(() => {
    connectionManager.start()
    return () => connectionManager.stop()
  }, [])

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
        <TamaguiThemed>
          <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
            Loading session…
          </div>
        </TamaguiThemed>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <TamaguiThemed>
        <NowProvider>
          <TamaguiHello />
          <Outlet />
          <Toaster duration={5000} />
        </NowProvider>
      </TamaguiThemed>
    </ThemeProvider>
  )
}

// Inner wrapper so TamaguiProvider sees the resolved theme from
// ThemeProvider's context. Keeping ThemeProvider outermost preserves
// the `useTheme()` contract for downstream consumers.
function TamaguiThemed({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme()
  return (
    <TamaguiProvider config={tamaguiConfig} defaultTheme={resolvedTheme}>
      <Theme name={resolvedTheme}>{children}</Theme>
    </TamaguiProvider>
  )
}
