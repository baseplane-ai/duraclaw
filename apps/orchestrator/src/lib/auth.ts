import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './auth-schema'

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

  const trustedOrigins = isLocalDev
    ? (request?: Request) => {
        const reqOrigin = request?.headers.get('origin')
        const extras = reqOrigin ? [reqOrigin] : []
        return [...new Set([...staticOrigins, ...extras])]
      }
    : undefined

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
    plugins: [admin()],
  })
}

export type Auth = ReturnType<typeof createAuth>
