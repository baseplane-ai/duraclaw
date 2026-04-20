import { adminClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { apiBaseUrl, isNative } from './platform'

const baseURL =
  typeof window === 'undefined'
    ? 'http://localhost/api/auth'
    : `${apiBaseUrl() || window.location.origin}/api/auth`

type ResolvedAuthClient = ReturnType<typeof createAuthClient>

async function buildAuthClient(): Promise<ResolvedAuthClient> {
  if (isNative()) {
    // Dynamic import keeps better-auth-capacitor out of the web bundle —
    // the `if (isNative())` branch is dead-code-eliminated when
    // VITE_PLATFORM !== 'capacitor', so the import() call is dropped too.
    const { withCapacitor } = await import('better-auth-capacitor/client')
    return createAuthClient(
      withCapacitor(
        { baseURL, plugins: [adminClient()] },
        { scheme: 'duraclaw', storagePrefix: 'better-auth' },
      ),
    )
  }
  return createAuthClient({ baseURL, plugins: [adminClient()] })
}

// On web the build path is fully synchronous (no dynamic import after
// dead-code elimination), so the resolved client is available the moment
// the microtask following `buildAuthClient()` runs. On native, callers
// should `await authClientReady` from `entry-client.tsx` before render.
export const authClientReady: Promise<ResolvedAuthClient> = buildAuthClient()

let _resolvedClient: ResolvedAuthClient | null = null
authClientReady.then((c) => {
  _resolvedClient = c
})

export function getAuthClient(): ResolvedAuthClient {
  if (!_resolvedClient) {
    throw new Error('authClient not yet initialised — await authClientReady first')
  }
  return _resolvedClient
}

// Backwards-compat re-exports so the 10 existing consumers don't need to
// change. These trip the `getAuthClient()` guard if accessed before
// `authClientReady` resolves; on web that's a single microtask after
// module init, on native it requires the top-level await in entry-client.
export const authClient: any = new Proxy(
  {},
  {
    get(_target, prop) {
      return (getAuthClient() as any)[prop]
    },
  },
)

export const useSession: any = (...args: any[]) => (getAuthClient() as any).useSession(...args)

export const signIn: any = new Proxy(
  {},
  {
    get(_target, prop) {
      return (getAuthClient() as any).signIn[prop]
    },
  },
)

export const signOut: any = (...args: any[]) => (getAuthClient() as any).signOut(...args)

export const signUp: any = new Proxy(
  {},
  {
    get(_target, prop) {
      return (getAuthClient() as any).signUp[prop]
    },
  },
)
