import { createFileRoute } from '@tanstack/react-router'
import { getCloudflareEnv } from '~/lib/cf-env'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const Route = createFileRoute('/api/sessions/$id/abort')({
  server: {
    handlers: {
      POST: async ({ params }) => {
        const env = getCloudflareEnv()
        try {
          const doId = env.SESSION_AGENT.idFromString(params.id)
          const sessionDO = env.SESSION_AGENT.get(doId)
          const resp = await sessionDO.fetch(
            new Request('https://session/abort', {
              method: 'POST',
              headers: { 'x-partykit-room': params.id },
            }),
          )
          if (!resp.ok) {
            const err = await resp.json() as { error?: string }
            return json(400, { error: err.error ?? 'Abort failed' })
          }
          return json(200, { status: 'aborted' })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          return json(400, { error: msg })
        }
      },
    },
  },
})
