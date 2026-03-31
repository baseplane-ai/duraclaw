import { createAPIFileRoute } from '@tanstack/react-start/api'
import { createAuth } from '~/lib/auth'
import { getCloudflareEnv } from '~/lib/cf-env'

export const APIRoute = createAPIFileRoute('/api/auth/$')({
  GET: async ({ request }) => {
    const env = getCloudflareEnv()
    const auth = createAuth(env)
    return auth.handler(request)
  },
  POST: async ({ request }) => {
    const env = getCloudflareEnv()
    const auth = createAuth(env)
    return auth.handler(request)
  },
})
