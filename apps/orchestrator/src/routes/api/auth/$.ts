import { createFileRoute } from '@tanstack/react-router'
import { createAuth } from '~/lib/auth'
import { getCloudflareEnv } from '~/lib/cf-env'

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
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
    },
  },
})
