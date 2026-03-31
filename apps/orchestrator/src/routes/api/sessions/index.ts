import { createAPIFileRoute } from '@tanstack/react-start/api'
import { getCloudflareEnv } from '~/lib/cf-env'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const APIRoute = createAPIFileRoute('/api/sessions')({
  GET: async () => {
    const env = getCloudflareEnv()
    const registryId = env.SESSION_REGISTRY.idFromName('default')
    const registry = env.SESSION_REGISTRY.get(registryId) as any
    const sessions = await registry.listSessions()
    return json(200, { sessions })
  },

  POST: async ({ request }) => {
    const env = getCloudflareEnv()
    const body = (await request.json()) as {
      worktree: string
      prompt: string
      model?: string
      system_prompt?: string
    }

    if (!body.worktree || !body.prompt) {
      return json(400, { error: 'Missing required fields: worktree, prompt' })
    }

    // Acquire worktree lock
    const registryId = env.SESSION_REGISTRY.idFromName('default')
    const registry = env.SESSION_REGISTRY.get(registryId) as any

    const sessionId = crypto.randomUUID()
    const locked = await registry.acquireWorktree(body.worktree, sessionId)
    if (!locked) {
      return json(409, { error: 'Worktree is already in use by another session' })
    }

    // Resolve worktree path from gateway
    let worktreePath = ''
    if (env.CC_GATEWAY_URL) {
      try {
        const gatewayUrl = new URL('/worktrees', env.CC_GATEWAY_URL)
        const headers: Record<string, string> = {}
        if (env.CC_GATEWAY_SECRET) {
          headers['Authorization'] = `Bearer ${env.CC_GATEWAY_SECRET}`
        }
        const resp = await fetch(gatewayUrl.toString(), { headers })
        if (resp.ok) {
          const worktrees = (await resp.json()) as any[]
          const wt = worktrees.find((w: any) => w.name === body.worktree)
          if (wt) worktreePath = wt.path
        }
      } catch {
        // Fall back to convention
      }
    }
    if (!worktreePath) {
      worktreePath = `/data/projects/${body.worktree}`
    }

    // Create SessionDO
    const doId = env.SESSION_AGENT.idFromString(sessionId)
    const sessionDO = env.SESSION_AGENT.get(doId) as any
    await sessionDO.create({
      worktree: body.worktree,
      worktree_path: worktreePath,
      prompt: body.prompt,
      model: body.model,
      system_prompt: body.system_prompt,
    })

    // Register in session index
    const now = new Date().toISOString()
    await registry.registerSession({
      id: sessionId,
      worktree: body.worktree,
      status: 'running',
      model: body.model ?? null,
      created_at: now,
      updated_at: now,
      prompt: body.prompt,
    })

    return json(201, { session_id: sessionId })
  },
})
