import handler from '@tanstack/react-start/server-entry'
import { SessionDO } from './agents/session-do'
import { WorktreeRegistry } from './agents/worktree-registry'
import { setCloudflareEnv } from './lib/cf-env'
import type { Env } from './lib/types'

const WS_ROUTE = /^\/api\/sessions\/([^/]+)\/ws$/

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    setCloudflareEnv(env)

    // Handle WebSocket upgrades to SessionDO
    const url = new URL(request.url)
    const wsMatch = url.pathname.match(WS_ROUTE)
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const sessionId = wsMatch[1]
      try {
        const doId = env.SESSION_AGENT.idFromString(sessionId)
        const stub = env.SESSION_AGENT.get(doId)
        return stub.fetch(request)
      } catch {
        return new Response('Invalid session ID', { status: 400 })
      }
    }

    return (handler.fetch as Function)(request, env, ctx)
  },
}

export { SessionDO, WorktreeRegistry }
