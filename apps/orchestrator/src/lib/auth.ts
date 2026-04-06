import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './auth-schema'

/**
 * Create a Better Auth instance for the current request.
 * Must be per-request because D1 bindings are only available in request context.
 */
export function createAuth(env: {
  AUTH_DB: D1Database
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL?: string
}) {
  const db = drizzle(env.AUTH_DB, { schema })
  const isLocalDev =
    !env.BETTER_AUTH_URL ||
    env.BETTER_AUTH_URL.includes('localhost') ||
    env.BETTER_AUTH_URL.includes('127.0.0.1')
  const trustedOrigins = isLocalDev
    ? Array.from(
        new Set(
          [env.BETTER_AUTH_URL, 'http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*'].filter(
            (origin): origin is string => Boolean(origin),
          ),
        ),
      )
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
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
