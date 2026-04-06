import { Hono } from 'hono'
import { createAuth } from '~/lib/auth'
import type { Env } from '~/lib/types'

const authRoutes = new Hono<{ Bindings: Env }>()

authRoutes.all('/*', async (c) => {
  const auth = createAuth(c.env)
  return auth.handler(c.req.raw)
})

export { authRoutes }
