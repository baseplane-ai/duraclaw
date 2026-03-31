import { createAPIFileRoute } from '@tanstack/react-start/api'
import { getCloudflareEnv } from '~/lib/cf-env'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const APIRoute = createAPIFileRoute('/api/sessions/$id/messages')({
  GET: async ({ params }) => {
    const env = getCloudflareEnv()
    try {
      const doId = env.SESSION_AGENT.idFromString(params.id)
      const sessionDO = env.SESSION_AGENT.get(doId) as any
      const messages = await sessionDO.getMessages()
      return json(200, { messages })
    } catch {
      return json(404, { error: 'Session not found' })
    }
  },
})
