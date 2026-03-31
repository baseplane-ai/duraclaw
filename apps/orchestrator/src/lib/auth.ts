import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/d1'

/**
 * Create a Better Auth instance for the current request.
 * Must be per-request because D1 bindings are only available in request context.
 */
export function createAuth(env: {
  AUTH_DB: D1Database
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL?: string
}) {
  const db = drizzle(env.AUTH_DB)

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
