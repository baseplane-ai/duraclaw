import { createFileRoute } from '@tanstack/react-router'
import { getCloudflareEnv } from '~/lib/cf-env'

export const Route = createFileRoute('/api/sessions/active')({
  server: {
    handlers: {
      GET: async () => {
        const env = getCloudflareEnv()
        const registryId = env.SESSION_REGISTRY.idFromName('default')
        const registry = env.SESSION_REGISTRY.get(registryId) as any
        const sessions = await registry.listActiveSessions()
        return new Response(JSON.stringify({ sessions }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
