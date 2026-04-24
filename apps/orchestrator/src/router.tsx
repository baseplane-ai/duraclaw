import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function createRouter() {
  return createTanStackRouter({ routeTree })
}

let routerInstance: ReturnType<typeof createRouter> | undefined
export function getRouter() {
  if (!routerInstance) {
    routerInstance = createRouter()
    // Expose to module-level handlers (e.g. native-push-deep-link) that
    // need to navigate without holding a React ref. SSR-safe: skipped on
    // server because `globalThis` is also defined there but the assignment
    // is harmless — the listener that reads it never runs server-side.
    if (typeof globalThis !== 'undefined') {
      ;(
        globalThis as typeof globalThis & {
          __duraclaw_router__?: ReturnType<typeof createRouter>
        }
      ).__duraclaw_router__ = routerInstance
    }
  }
  return routerInstance
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
