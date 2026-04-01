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

        // Get worktree locks from registry
        const registryId = env.SESSION_REGISTRY.idFromName('default')
        const registry = env.SESSION_REGISTRY.get(registryId) as any
        const locks = (await registry.getWorktreeLocks()) as Record<string, string>

        // Fetch worktrees from gateway
        if (!env.CC_GATEWAY_URL) {
          return json(502, { error: 'CC_GATEWAY_URL not configured' })
        }

        try {
          const gatewayUrl = new URL('/worktrees', env.CC_GATEWAY_URL)
          const headers: Record<string, string> = {}
          if (env.CC_GATEWAY_SECRET) {
            headers['Authorization'] = `Bearer ${env.CC_GATEWAY_SECRET}`
          }
          const resp = await fetch(gatewayUrl.toString(), { headers })
          if (!resp.ok) {
            return json(502, { error: 'Gateway returned error' })
          }

          const worktrees = (await resp.json()) as any[]
          // Merge lock info
          const merged = worktrees.map((wt: any) => ({
            ...wt,
            locked_by_session: locks[wt.name] ?? null,
          }))

          return json(200, { worktrees: merged })
        } catch {
          return json(502, { error: 'Gateway unreachable' })
        }
      },
    },
  },
})
