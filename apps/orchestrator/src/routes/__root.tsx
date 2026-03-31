import { createRootRoute, HeadContent, Outlet, redirect, Scripts } from '@tanstack/react-router'
import { getSession } from '~/lib/auth.functions'

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Skip auth check on the login page to avoid redirect loops
    if (location.pathname === '/login') {
      return
    }

    const session = await getSession()

    if (!session) {
      throw redirect({ to: '/login' })
    }

    return { session }
  },
  component: RootComponent,
})

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Duraclaw Orchestrator</title>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
