import { ProjectRegistry } from './agents/project-registry'
import { SessionDO } from './agents/session-do'
import { createApiApp } from './api'
import { getRequestSession } from './api/auth-session'
import type { Env } from './lib/types'

const WS_ROUTE = /^\/(?:api\/sessions|agents\/session-agent)\/([^/]+)(?:\/(ws|agent))?$/
const apiApp = createApiApp()

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)
    const wsMatch = url.pathname.match(WS_ROUTE)
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const authSession = await getRequestSession(env, request)
      if (!authSession) {
        return new Response('Unauthorized', { status: 401 })
      }

      const sessionId = wsMatch[1]
      try {
        const doId = env.SESSION_AGENT.idFromString(sessionId)
        const stub = env.SESSION_AGENT.get(doId)
        const headers = new Headers(request.headers)
        headers.set('x-partykit-room', sessionId)
        headers.set('x-user-id', authSession.userId)
        const wsRequest = new Request(request, { headers })
        return stub.fetch(wsRequest)
      } catch {
        return new Response('Invalid session ID', { status: 400 })
      }
    }

    if (url.pathname.startsWith('/api/')) {
      return apiApp.fetch(request, env, ctx)
    }

    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404) {
      return assetResponse
    }

    return env.ASSETS.fetch(new Request(new URL('/', request.url), request))
  },
}

export { ProjectRegistry, SessionDO }
