import { createFileRoute } from '@tanstack/react-router'
import { getCloudflareEnv } from '~/lib/cf-env'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const Route = createFileRoute('/api/sessions/')({
  server: {
    handlers: {
      GET: async () => {
        const env = getCloudflareEnv()
        const registryId = env.SESSION_REGISTRY.idFromName('default')
        const registry = env.SESSION_REGISTRY.get(registryId) as any
        const sessions = await registry.listSessions()
        return json(200, { sessions })
      },

      POST: async ({ request }) => {
        try {
        const env = getCloudflareEnv()
        const body = (await request.json()) as {
          project: string
          prompt: string
          model?: string
          system_prompt?: string
        }

        if (!body.project || !body.prompt) {
          return json(400, { error: 'Missing required fields: project, prompt' })
        }

        const registryId = env.SESSION_REGISTRY.idFromName('default')
        const registry = env.SESSION_REGISTRY.get(registryId) as any

        const doId = env.SESSION_AGENT.newUniqueId()
        const sessionId = doId.toString()

        // Resolve project path from gateway
        let projectPath = ''
        if (env.CC_GATEWAY_URL) {
          try {
            const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
            const gatewayUrl = new URL('/projects', httpBase)
            const headers: Record<string, string> = {}
            if (env.CC_GATEWAY_SECRET) {
              headers['Authorization'] = `Bearer ${env.CC_GATEWAY_SECRET}`
            }
            const resp = await fetch(gatewayUrl.toString(), { headers })
            if (resp.ok) {
              const projects = (await resp.json()) as any[]
              const wt = projects.find((w: any) => w.name === body.project)
              if (wt) projectPath = wt.path
            }
          } catch {
            // Fall back to convention
          }
        }
        if (!projectPath) {
          projectPath = `/data/projects/${body.project}`
        }

        // Create SessionDO via fetch (Agent SDK doesn't support RPC)
        const sessionDO = env.SESSION_AGENT.get(doId)
        const createResp = await sessionDO.fetch(
          new Request('https://session/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-partykit-room': sessionId,
            },
            body: JSON.stringify({
              project: body.project,
              project_path: projectPath,
              prompt: body.prompt,
              model: body.model,
              system_prompt: body.system_prompt,
            }),
          }),
        )
        if (!createResp.ok) {
          const errBody = await createResp.text()
          return json(500, { error: 'Failed to create session DO', status: createResp.status, body: errBody })
        }

        // Register in session index
        const now = new Date().toISOString()
        await registry.registerSession({
          id: sessionId,
          project: body.project,
          status: 'running',
          model: body.model ?? null,
          created_at: now,
          updated_at: now,
          prompt: body.prompt,
        })

        return json(201, { session_id: sessionId })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          const stack = err instanceof Error ? err.stack : undefined
          return json(500, { error: msg, stack })
        }
      },
    },
  },
})
