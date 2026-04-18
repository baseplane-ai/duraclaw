import { ProjectRegistry } from './agents/project-registry'
import { SessionCollabDO } from './agents/session-collab-do'
import { SessionDO } from './agents/session-do'
import { UserSettingsDO } from './agents/user-settings-do'
import { createApiApp } from './api'
import { getRequestSession } from './api/auth-session'
import type { Env } from './lib/types'

// Gateway + session-runner decoupling live on prod as of 2026-04-17 (#1).
const WS_ROUTE = /^\/(?:api\/sessions|agents\/session-agent)\/([^/]+)(?:\/(ws|agent))?$/
// Two patterns accepted:
//   /api/collab/:sessionId/ws       — spec canonical
//   /parties/session-collab/:room    — partyserver's default URL (from useYProvider)
// They both route to the same SESSION_COLLAB DO.
const COLLAB_WS_ROUTE = /^(?:\/api\/collab\/([^/]+)\/ws|\/parties\/session-collab\/([^/]+))$/
const apiApp = createApiApp()

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    // User settings DO — WS upgrade for live tab sync
    if (
      url.pathname === '/api/user-settings/ws' &&
      request.headers.get('Upgrade') === 'websocket'
    ) {
      const authSession = await getRequestSession(env, request)
      if (!authSession) {
        return new Response('Unauthorized', { status: 401 })
      }
      const doId = env.USER_SETTINGS.idFromName(authSession.userId)
      const stub = env.USER_SETTINGS.get(doId)
      const headers = new Headers(request.headers)
      headers.set('x-partykit-room', authSession.userId)
      headers.set('x-user-id', authSession.userId)
      return stub.fetch(new Request(request, { headers }))
    }

    // Session collab DO — WS upgrade for Yjs multiplayer draft sync
    const collabMatch = url.pathname.match(COLLAB_WS_ROUTE)
    if (collabMatch && request.headers.get('Upgrade') === 'websocket') {
      const sessionId = collabMatch[1] ?? collabMatch[2]
      if (!sessionId) {
        return new Response('Invalid session ID', { status: 400 })
      }
      const authSession = await getRequestSession(env, request)
      if (!authSession) {
        return new Response('Unauthorized', { status: 401 })
      }
      const doId = env.SESSION_COLLAB.idFromName(sessionId)
      const stub = env.SESSION_COLLAB.get(doId)
      const headers = new Headers(request.headers)
      headers.set('x-partykit-room', sessionId)
      headers.set('x-user-id', authSession.userId)
      return stub.fetch(new Request(request, { headers }))
    }

    const wsMatch = url.pathname.match(WS_ROUTE)
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const sessionId = wsMatch[1]
      const role = url.searchParams.get('role')

      try {
        const isHexId = /^[0-9a-f]{64}$/.test(sessionId)
        const doId = isHexId
          ? env.SESSION_AGENT.idFromString(sessionId)
          : env.SESSION_AGENT.idFromName(sessionId)
        const stub = env.SESSION_AGENT.get(doId)

        if (role === 'gateway') {
          // Gateway auth: validate token in the DO, not via Better Auth
          const token = url.searchParams.get('token') ?? ''
          const headers = new Headers(request.headers)
          headers.set('x-partykit-room', sessionId)
          headers.set('x-gateway-token', token)
          const wsRequest = new Request(request, { headers })
          return stub.fetch(wsRequest)
        }

        // Browser auth: require Better Auth session
        const authSession = await getRequestSession(env, request)
        if (!authSession) {
          return new Response('Unauthorized', { status: 401 })
        }

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

export { ProjectRegistry, SessionCollabDO, SessionDO, UserSettingsDO }
