import { createAPIFileRoute } from '@tanstack/react-start/api'
import { getCloudflareEnv } from '~/lib/cf-env'

export const APIRoute = createAPIFileRoute('/api/sessions/active')({
  GET: async () => {
    const env = getCloudflareEnv()
    const registryId = env.SESSION_REGISTRY.idFromName('default')
    const registry = env.SESSION_REGISTRY.get(registryId) as any
    const sessions = await registry.listActiveSessions()
    return new Response(JSON.stringify({ sessions }), {
      headers: { 'Content-Type': 'application/json' },
    })
  },
})
