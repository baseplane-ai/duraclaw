import { createFileRoute } from '@tanstack/react-router'
import { getCloudflareEnv } from '~/lib/cf-env'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const Route = createFileRoute('/api/sessions/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const env = getCloudflareEnv()
        try {
          const doId = env.SESSION_AGENT.idFromString(params.id)
          const sessionDO = env.SESSION_AGENT.get(doId) as any
          const state = await sessionDO.getSessionState()
          return json(200, { session: state })
        } catch {
          return json(404, { error: 'Session not found' })
        }
      },
    },
  },
})
