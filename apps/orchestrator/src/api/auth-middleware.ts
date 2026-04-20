import { createMiddleware } from 'hono/factory'
import { getRequestSession } from './auth-session'
import type { ApiAppEnv } from './context'

// Paths that use their own auth (Bearer tokens) and bypass session-cookie auth.
const BYPASS_PATHS = ['/api/gateway/', '/api/webhooks/', '/api/bootstrap']

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
  await next()
})
