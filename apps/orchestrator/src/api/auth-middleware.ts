import { createMiddleware } from 'hono/factory'
import { getRequestSession } from './auth-session'
import type { ApiAppEnv } from './context'

export const authMiddleware = createMiddleware<ApiAppEnv>(async (c, next) => {
  const session = await getRequestSession(c.env, c.req.raw)
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('userId', session.userId)
  await next()
})
