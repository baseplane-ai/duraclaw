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
      <h1>Duraclaw</h1>
      <p>Remote Workbench</p>
    </div>
  ),
})

const routeTree = rootRoute.addChildren([indexRoute])

export function createRouter() {
  return createTanStackRouter({ routeTree })
}

// TanStack Start v1.167+ expects getRouter
let routerInstance: ReturnType<typeof createRouter> | undefined
export function getRouter() {
  if (!routerInstance) {
    routerInstance = createRouter()
  }
  return routerInstance
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
