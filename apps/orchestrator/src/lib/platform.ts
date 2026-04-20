/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_PLATFORM?: string
    readonly VITE_API_BASE_URL?: string
    readonly VITE_WORKER_PUBLIC_URL?: string
  }
}

/**
 * Platform detection helpers for Capacitor vs web.
 *
 * `isNative()` keys off `import.meta.env.VITE_PLATFORM`, a build-time flag
 * set to `'capacitor'` in the mobile build (`apps/mobile/.env.production`)
 * and unset on the web build. Vite substitutes the literal value at build
 * time, so call sites like `if (isNative())` are tree-shaken on web —
 * the Capacitor SQLite plugin and other native-only modules are never
 * bundled into the browser build.
 *
 * `apiBaseUrl()` / `apiUrl()` resolve API origin for fetches: empty on web
 * (relative URLs against `window.location.origin`), the deployed Worker
 * URL on Capacitor (substituted at build time via `VITE_API_BASE_URL`).
 *
 * `wsBaseUrl()` returns the bare host used by partysocket / agents
 * `useAgent()` to dial the SessionDO. Empty on web → partysocket falls
 * back to `window.location.host`. On Capacitor builds: the hostname from
 * `VITE_WORKER_PUBLIC_URL` so the sandboxed `capacitor://localhost` page
 * connects to the cloud Worker over wss.
 */

export function isNative(): boolean {
  return import.meta.env.VITE_PLATFORM === 'capacitor'
}

export function apiBaseUrl(): string {
  // Empty on web → relative URLs resolve against window.location.origin
  // On native (Capacitor): the deployed Worker URL, set at build time.
  return import.meta.env.VITE_API_BASE_URL ?? ''
}

/**
 * Prepend the API base URL to a path. Web builds: returns the path unchanged
 * (relative, served from same origin). Capacitor builds: prefixes with the
 * deployed Worker URL so fetches go to the cloud rather than a non-existent
 * native server.
 *
 * Use for ALL client-side fetches that hit `/api/*` or `/parties/*`.
 */
export function apiUrl(path: string): string {
  const base = apiBaseUrl()
  if (!base) return path
  // Avoid double-slash if base ends with / and path starts with /
  return base.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`)
}

/**
 * Bare host (no protocol) used by partysocket / agents `useAgent()` to
 * dial the SessionDO. Empty on web → partysocket falls back to
 * `window.location.host`. On Capacitor builds: the hostname from
 * `VITE_WORKER_PUBLIC_URL` (e.g. `duraclaw.example.com`), so the
 * sandboxed `capacitor://localhost` page connects to the cloud Worker
 * over wss.
 */
/**
 * Install a global fetch interceptor that injects the bearer token from
 * Capacitor Preferences on every request to the API base URL. On web
 * builds this is a no-op (tree-shaken). Must be called once at startup
 * (entry-client.tsx) AFTER authClientReady resolves.
 */
export async function installNativeFetchInterceptor(): Promise<void> {
  if (!isNative()) return
  const base = apiBaseUrl()
  if (!base) return

  const { getCapacitorAuthToken } = await import('better-auth-capacitor/client')
  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    // Only inject for requests to our API (skip auth endpoints — handled by auth client)
    if (url.startsWith(base) && !url.includes('/api/auth/')) {
      const token = await getCapacitorAuthToken({ storagePrefix: 'better-auth' })
      if (token) {
        const headers = new Headers(init?.headers)
        if (!headers.has('Authorization')) {
          headers.set('Authorization', `Bearer ${token}`)
        }
        init = { ...init, headers, credentials: 'omit' }
      }
    }
    return originalFetch(input, init)
  }
}

export function wsBaseUrl(): string {
  const url = import.meta.env.VITE_WORKER_PUBLIC_URL ?? ''
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
