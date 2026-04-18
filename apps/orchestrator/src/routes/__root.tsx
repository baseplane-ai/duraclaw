import { createRootRoute, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { OfflineBanner } from '~/components/offline-banner'
import { Toaster } from '~/components/ui/sonner'
import { ThemeProvider } from '~/context/theme-provider'
import { useInvalidationChannel } from '~/hooks/use-invalidation-channel'
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

  // PartyKit invalidation channel — opens once a userId is available, no-op
  // until then. Sole subscriber to D1 row-change broadcasts (B-CLIENT-5).
  useInvalidationChannel()

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
