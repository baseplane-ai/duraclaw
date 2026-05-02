// Native-only typed wrapper around React Navigation's `useRoute().params`.
//
// Mirrors TanStack Router's `useParams()` ergonomics so shared screen
// components can take params via a single helper instead of an explicit
// prop each time. For the duraclaw codebase the more common pattern is
// the route-wrapper passing params as PROPS to the shared screen — this
// hook is the native side of that wrapper boundary.
//
// Web should NOT import this — TanStack Router's own `useParams()` is
// web-only and richer (typed by route id). This file imports
// `@react-navigation/native`, which the web bundle does not resolve.

import { useRoute } from '@react-navigation/native'

export function useRouteParams<T extends Record<string, unknown>>(): T {
  const route = useRoute()
  return (route.params ?? {}) as T
}
