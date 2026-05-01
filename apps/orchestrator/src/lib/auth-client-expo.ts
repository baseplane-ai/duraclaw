/**
 * @better-auth/expo wrapper for the Expo SDK 55 native target.
 *
 * Mirrors the role of `better-auth-capacitor/client` from the Capacitor
 * shell: builds the `createAuthClient` config with a native storage
 * backend (expo-secure-store) and exposes a token-fetch helper that
 * `platform.ts:installNativeFetchInterceptor` consumes.
 *
 * API-shape note (from spike — see planning/research/2026-04-30-gh132-p3-spike-results.md):
 *   `@better-auth/expo` exposes `expoClient(opts)` as a Better Auth
 *   PLUGIN (drop into `plugins:` array), not a config-wrapper like
 *   `withCapacitor(config, opts)`. This wrapper hides that shape
 *   difference behind one boundary so `auth-client.ts` stays clean.
 */

import { adminClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

// expo-secure-store is dynamic-imported below — same `@vite-ignore`
// pattern as the rest of the native-only branches. The package isn't a
// declared dep of apps/orchestrator (it ships in apps/mobile-expo's
// node_modules at runtime).
type SecureStoreModule = {
  getItem: (key: string) => string | null
  getItemAsync: (key: string) => Promise<string | null>
  setItemAsync: (key: string, value: string) => Promise<void>
}
let _secureStore: SecureStoreModule | null = null
async function loadSecureStore(): Promise<SecureStoreModule> {
  if (_secureStore) return _secureStore
  _secureStore = (await import(/* @vite-ignore */ 'expo-secure-store')) as SecureStoreModule
  return _secureStore
}

const EXPO_STORAGE_PREFIX = 'better-auth'

/**
 * The session token key that `@better-auth/expo` stores under. The
 * plugin normalises cookie names by replacing colons with underscores
 * (see `normalizeCookieName` in the package). For the canonical
 * Better Auth session cookie (`better-auth.session_token`), the
 * resulting key is `better-auth.session_token` unchanged.
 *
 * Exported so `getExpoAuthToken()` and any debug tooling agree on
 * the lookup key. Kept consistent with the Capacitor convention
 * (`storagePrefix: 'better-auth'`).
 */
export const EXPO_TOKEN_KEY = `${EXPO_STORAGE_PREFIX}.session_token`

export async function buildExpoAuthClient(baseURL: string) {
  // Dynamic + @vite-ignore: @better-auth/expo lives in
  // apps/mobile-expo's node_modules, not orchestrator's.
  const expoMod = (await import(/* @vite-ignore */ '@better-auth/expo/client')) as {
    expoClient: (opts: unknown) => unknown
  }
  const SecureStore = await loadSecureStore()
  const secureStoreAdapter = {
    getItem: (key: string): string | null => {
      try {
        return SecureStore.getItem(key)
      } catch {
        return null
      }
    },
    setItem: (key: string, value: string): void => {
      void SecureStore.setItemAsync(key, value)
    },
  }
  return createAuthClient({
    baseURL,
    plugins: [
      adminClient(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expoMod.expoClient({
        scheme: 'duraclaw',
        storagePrefix: EXPO_STORAGE_PREFIX,
        storage: secureStoreAdapter,
      }) as any,
    ],
  })
}

/**
 * Read the bearer token directly from expo-secure-store. Used by
 * `platform.ts:installNativeFetchInterceptor` to inject the
 * `Authorization: Bearer <token>` header on every `apiBaseUrl()`-rooted
 * fetch, and by `use-coding-agent.ts` to hoist the token onto the WS
 * `_authToken` query param.
 *
 * Returns null if no token is stored (unauthenticated state). The
 * caller decides whether to surface that as a redirect to /login or a
 * silent fall-through.
 */
export async function getExpoAuthToken(): Promise<string | null> {
  try {
    const SecureStore = await loadSecureStore()
    return await SecureStore.getItemAsync(EXPO_TOKEN_KEY)
  } catch {
    return null
  }
}
