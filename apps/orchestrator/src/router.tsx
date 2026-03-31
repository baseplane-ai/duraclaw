import {
  createRootRoute,
  createRoute,
  createRouter as createTanStackRouter,
} from '@tanstack/react-router'

const rootRoute = createRootRoute()

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => (
    <div>
      <h1>NRW Orchestrator</h1>
      <p>Session management dashboard</p>
    </div>
  ),
})

const routeTree = rootRoute.addChildren([indexRoute])

export function createRouter() {
  return createTanStackRouter({ routeTree })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
