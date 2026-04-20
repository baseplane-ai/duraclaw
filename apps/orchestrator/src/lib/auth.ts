import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, bearer } from 'better-auth/plugins'
import { capacitor } from 'better-auth-capacitor'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'

/**
 * Create a Better Auth instance for the current request.
 * Must be per-request because D1 bindings are only available in request context.
 */
export function createAuth(
  env: {
    AUTH_DB: D1Database
    BETTER_AUTH_SECRET: string
    BETTER_AUTH_URL?: string
  },
  opts?: { allowSignUp?: boolean },
) {
  const db = drizzle(env.AUTH_DB, { schema })
  const isLocalDev =
    !env.BETTER_AUTH_URL ||
    env.BETTER_AUTH_URL.includes('localhost') ||
    env.BETTER_AUTH_URL.includes('127.0.0.1')
  // In local dev, wrangler rewrites request URLs to the [[routes]] custom_domain
  // (e.g. http://dura.baseplane.ai) even though the browser is on localhost.
  // Use a function-based trustedOrigins to also trust the request's rewritten origin.
  const staticOrigins = [
    env.BETTER_AUTH_URL,
    'http://localhost:*',
    'http://127.0.0.1:*',
    'http://[::1]:*',
  ].filter((origin): origin is string => Boolean(origin))

  // Capacitor WebView with androidScheme:'https' sends Origin: https://localhost.
  // The capacitor() plugin only adds capacitor:// to trustedOrigins (for the
  // capacitor:// scheme), so we must always include https://localhost for the
  // mobile app to pass Better Auth's CSRF check in production.
  const trustedOrigins = isLocalDev
    ? (request?: Request) => {
        const reqOrigin = request?.headers.get('origin')
        const extras = reqOrigin ? [reqOrigin] : []
        return [...new Set([...staticOrigins, ...extras])]
      }
    : ['https://localhost']

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !opts?.allowSignUp,
    },
    // capacitor() adds `capacitor://` to trustedOrigins via its `init` hook
    // and enables bearer-token replay for Capacitor clients (which have no
    // cookie jar that survives WebView restarts). The `https://localhost`
    // origin (from androidScheme:'https') is added above in trustedOrigins.
    // bearer() extracts session tokens from Set-Cookie into a
    // `set-auth-token` response header (+ Access-Control-Expose-Headers)
    // so the Capacitor client can store the token. It also converts
    // incoming `Authorization: Bearer <token>` to session cookies for
    // server-side session lookup.
    plugins: [admin(), bearer(), capacitor()],
  })
}

export type Auth = ReturnType<typeof createAuth>
