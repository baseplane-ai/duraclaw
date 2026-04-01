import { createFileRoute } from '@tanstack/react-router'
import { getCloudflareEnv } from '~/lib/cf-env'

export const Route = createFileRoute('/api/sessions/active')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const env = getCloudflareEnv()
          const registryId = env.SESSION_REGISTRY.idFromName('default')
          const registry = env.SESSION_REGISTRY.get(registryId) as any
          const sessions = await registry.listActiveSessions()
          return new Response(JSON.stringify({ sessions }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          const stack = err instanceof Error ? err.stack : undefined
          return new Response(JSON.stringify({ error: msg, stack }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      },
    },
  },
})
