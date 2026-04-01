import { createFileRoute } from '@tanstack/react-router'
import { getCloudflareEnv } from '~/lib/cf-env'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const Route = createFileRoute('/api/worktrees')({
  server: {
    handlers: {
      GET: async () => {
        const env = getCloudflareEnv()

        const registryId = env.SESSION_REGISTRY.idFromName('default')
        const registry = env.SESSION_REGISTRY.get(registryId) as any

        // Fetch worktrees from gateway
        if (!env.CC_GATEWAY_URL) {
          return json(502, { error: 'CC_GATEWAY_URL not configured' })
        }

        try {
          const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
          const gatewayUrl = new URL('/worktrees', httpBase)
          const headers: Record<string, string> = {}
          if (env.CC_GATEWAY_SECRET) {
            headers['Authorization'] = `Bearer ${env.CC_GATEWAY_SECRET}`
          }
          const resp = await fetch(gatewayUrl.toString(), { headers })
          if (!resp.ok) {
            return json(502, { error: 'Gateway returned error' })
          }

          const worktrees = (await resp.json()) as any[]
          // Attach sessions for each worktree
          const merged = await Promise.all(
            worktrees.map(async (wt: any) => ({
              ...wt,
              sessions: await registry.listSessionsByWorktree(wt.name),
            })),
          )

          return json(200, { worktrees: merged })
        } catch {
          return json(502, { error: 'Gateway unreachable' })
        }
      },
    },
  },
})
