import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    // Visible fallback so route Suspense boundaries never render blank.
    // Without this, TanStack Router's per-Match <Suspense> has fallback={null}
    // which, combined with React 19 Offscreen hiding, causes a blank screen
    // on Capacitor WebView (see react-offscreen-patch.ts).
    defaultPendingComponent: () => (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    ),
  })
}

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
