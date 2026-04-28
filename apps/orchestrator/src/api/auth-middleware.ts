import { createMiddleware } from 'hono/factory'
import { getRequestSession } from './auth-session'
import type { ApiAppEnv } from './context'

// Paths that use their own auth (Bearer tokens) and bypass session-cookie auth.
// Note: `/api/gateway/projects/sync` is the gateway's project-manifest push
// (Bearer-authed). `/api/gateway/worktrees/upsert` is the GH#115 P1.3 sweep
// push (also Bearer-authed). The two GET sibling endpoints
// (`/api/gateway/projects` and `/api/gateway/projects/all`) are
// browser-client endpoints that need the session cookie to resolve `userId`
// for hidden-project filtering — keeping them under the session middleware
// prevents a D1_TYPE_ERROR on an undefined userId reaching drizzle's `eq()`.
const BYPASS_PATHS = [
  '/api/gateway/projects/sync',
  '/api/gateway/worktrees/upsert',
  '/api/webhooks/',
  '/api/bootstrap',
]

export const authMiddleware = createMiddleware<ApiAppEnv>(async (c, next) => {
  const path = c.req.path
  if (BYPASS_PATHS.some((p) => path.startsWith(p))) {
    await next()
    return
  }

  const session = await getRequestSession(c.env, c.req.raw)
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('userId', session.userId)
  c.set('role', session.role)
  await next()
})
