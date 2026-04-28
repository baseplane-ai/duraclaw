import { createMiddleware } from 'hono/factory'
import { getRequestSession } from './auth-session'
import type { ApiAppEnv } from './context'

// Paths that use their own auth (Bearer tokens) and bypass session-cookie auth.
// Note: `/api/gateway/projects/sync` is the gateway's project-manifest push
// (Bearer-authed). `/api/gateway/worktrees/upsert` is the GH#115 P1.3 sweep
// push (also Bearer-authed). `/api/kata/worktrees/reserve` is the GH#115
// kata-CLI reservation endpoint (Bearer-authed via CC_GATEWAY_SECRET — kata
// has no session cookie, runs on the same VPS as the gateway, and shares
// that secret). The two GET sibling endpoints
// (`/api/gateway/projects` and `/api/gateway/projects/all`) are
// browser-client endpoints that need the session cookie to resolve `userId`
// for hidden-project filtering — keeping them under the session middleware
// prevents a D1_TYPE_ERROR on an undefined userId reaching drizzle's `eq()`.
const BYPASS_PATHS = [
  '/api/gateway/projects/sync',
  '/api/gateway/worktrees/upsert',
  '/api/kata/worktrees/reserve',
  '/api/webhooks/',
  '/api/bootstrap',
]

export const authMiddleware = createMiddleware<ApiAppEnv>(async (c, next) => {
  const path = c.req.path
  if (BYPASS_PATHS.some((p) => path.startsWith(p))) {
    await next()
    return
  }

  // Better Auth's `getRequestSession` does internal fetches against its
  // own routes; on a no-cookie / malformed-cookie request that path can
  // throw rather than cleanly returning null (observed under miniflare
  // dispatch). Treat thrown lookups the same as a missing session — 401,
  // not 500. Without this guard, kata / curl probes that lack auth
  // surface as a `fetch failed` 500 from the vite plugin layer.
  let session: Awaited<ReturnType<typeof getRequestSession>> | null = null
  try {
    session = await getRequestSession(c.env, c.req.raw)
  } catch (err) {
    console.warn(`[auth-middleware] getRequestSession threw: ${(err as Error).message ?? err}`)
    session = null
  }
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('userId', session.userId)
  c.set('role', session.role)
  await next()
})
