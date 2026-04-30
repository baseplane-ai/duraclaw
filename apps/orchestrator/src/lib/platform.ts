/// <reference types="vite/client" />
import { Platform } from 'react-native'

declare global {
  interface ImportMetaEnv {
    readonly VITE_PLATFORM?: string
    readonly VITE_API_BASE_URL?: string
    readonly VITE_WORKER_PUBLIC_URL?: string
    readonly VITE_APP_VERSION?: string
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

/**
 * True on the Expo SDK 55 native runtime (Metro bundler, real Android/iOS).
 *
 * Distinct from `isNative()` (Capacitor) because the two builds use
 * different bundlers and different platform-detection signals. On the
 * Vite web build and the Vite Capacitor build, react-native-web shims
 * `Platform.OS` to `'web'`, so this returns false. On the Metro/Expo
 * build, `Platform.OS` is `'android'` or `'ios'`.
 *
 * Used by `db-instance.ts` to select the op-sqlite persistence and by
 * `auth-client.ts` to dispatch to `@better-auth/expo` instead of
 * `better-auth-capacitor`. Native imports are dynamic so they're
 * tree-shaken from the Vite bundle.
 */
export function isExpoNative(): boolean {
  // P2 already pulls react-native (via react-native-web alias on Vite)
  // into the bundle — see `entry-rn.tsx`. On the Vite web build and the
  // Vite Capacitor build, RNW shims Platform.OS to `'web'`, so this
  // returns false. On the Metro/Expo build, Platform.OS is
  // `'android'` (or `'ios'`).
  return Platform.OS !== 'web'
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
  // Three branches:
  //  1. Capacitor (VITE_PLATFORM=capacitor): Preferences-backed bearer token
  //     via better-auth-capacitor/client.
  //  2. Expo (Platform.OS !== 'web'): expo-secure-store-backed token via
  //     better-auth-expo. No `window` reference — `globalThis.fetch` is
  //     polyfilled by RN.
  //  3. Web: no-op (cookies handle auth).
  if (isExpoNative()) {
    const base = apiBaseUrl()
    if (!base) return
    const { getExpoAuthToken } = await import(/* @vite-ignore */ './auth-client-expo')
    const originalFetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(base) && !url.includes('/api/auth/')) {
        const token = await getExpoAuthToken()
        if (token) {
          const headers = new Headers(init?.headers)
          if (!headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${token}`)
          }
          init = { ...init, headers, credentials: 'omit' }
        }
      }
      return originalFetch(input, init)
    }) as typeof fetch
    return
  }

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

/**
 * Host for PartyServer / Yjs WebSocket connections. On web builds: returns
 * `window.location.host` (same-origin, the Worker itself). On Capacitor
 * builds: returns the deployed Worker host from `VITE_WORKER_PUBLIC_URL`
 * so WS connections go to the cloud instead of the local WebView.
 *
 * Use this instead of raw `window.location.host` in any `useYProvider` /
 * `partysocket` / invalidation-channel hook.
 */
export function partyHost(): string {
  return wsBaseUrl() || (typeof window !== 'undefined' ? window.location.host : '')
}
