import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { routePartykitRequest } from 'partyserver'
import { SessionCollabDOv2 } from './agents/session-collab-do'
import { SessionCollabDO } from './agents/session-collab-do-legacy'
import { SessionDO } from './agents/session-do'
import { UserSettingsDO } from './agents/user-settings-do'
import { createApiApp } from './api'
import type { RequestSession } from './api/auth-session'
import { getRequestSession } from './api/auth-session'
import { scheduled } from './api/scheduled'
import * as schema from './db/schema'
import { agentSessions } from './db/schema'
import type { Env } from './lib/types'

/**
 * Spec #68 B8 / B9 — shared ACL gate for WS upgrades.
 *
 * Returns `true` if the authenticated user may open a WS connection for
 * `sessionId` (owner, or session is public, or user is admin). Also
 * returns `true` when the session doesn't yet exist in D1 (race with
 * create) — the DO's own onConnect will reject if the session truly
 * doesn't exist, preserving the pre-existing race-friendly behaviour.
 */
async function checkSessionAccess(
  env: Env,
  sessionId: string,
  authSession: RequestSession,
): Promise<boolean> {
  const db = drizzle(env.AUTH_DB, { schema })
  const rows = await db
    .select({ userId: agentSessions.userId, visibility: agentSessions.visibility })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1)
  const sessionRow = rows[0]
  if (!sessionRow) return true
  const isOwner = sessionRow.userId === authSession.userId || sessionRow.userId === 'system'
  const isPublic = sessionRow.visibility === 'public'
  const isAdmin = authSession.role === 'admin'
  return isOwner || isPublic || isAdmin
}

// Gateway + session-runner decoupling live on prod as of 2026-04-17 (#1).
const WS_ROUTE = /^\/(?:api\/sessions|agents\/session-agent)\/([^/]+)(?:\/(ws|agent))?$/

// CORS allowlist for the Capacitor Android shell (#26). The native WebView
// runs at `capacitor://localhost`; in dev verify-mode the orchestrator and
// gateway also bind to `http://localhost:<port>` / `127.0.0.1:<port>`. The
// deployed Worker origin (`BETTER_AUTH_URL`) is allowlisted explicitly so
// production responses are CORS-credentialled for the mobile app.
const ALLOWED_ORIGIN_RE =
  /^(?:capacitor:\/\/localhost|https?:\/\/localhost(?::\d+)?|https?:\/\/127\.0\.0\.1(?::\d+)?)$/

function corsHeaders(origin: string | null, env: Env): HeadersInit | null {
  if (!origin) return null
  const allowed = ALLOWED_ORIGIN_RE.test(origin) || origin === env.BETTER_AUTH_URL
  if (!allowed) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Requested-With, capacitor-origin, x-skip-oauth-proxy',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'set-auth-token',
    'Access-Control-Max-Age': '86400',
  }
}

// Two patterns accepted:
//   /api/collab/:sessionId/ws       — spec canonical
//   /parties/session-collab/:room    — partyserver's default URL (from useYProvider)
// They both route to the same SESSION_COLLAB DO.
const COLLAB_WS_ROUTE = /^(?:\/api\/collab\/([^/]+)\/ws|\/parties\/session-collab\/([^/]+))$/
const apiApp = createApiApp()

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    // Capacitor WS upgrades can't attach cookies (cross-origin) or custom
    // headers (browser WS limitation), so native clients pass the bearer
    // token via `?_authToken=<jwt>`. Hoist it to `Authorization: Bearer`
    // once at the top so every downstream auth path — getRequestSession
    // inside DO onConnect, routePartykitRequest's `/parties/*` dispatch,
    // the collab WS route — sees an authenticated request. Previously
    // only the session-agent WS branch did this inline, which left
    // `/parties/user-settings/*` (user-stream WS) perma-rejecting on
    // native and thrashing via partysocket's reconnect loop.
    const tokenFromQuery = url.searchParams.get('_authToken')
    if (tokenFromQuery && !request.headers.get('Authorization')) {
      const headers = new Headers(request.headers)
      headers.set('Authorization', `Bearer ${tokenFromQuery}`)
      request = new Request(request, { headers })
    }

    // CORS preflight for Capacitor + dev origins (#26). WS upgrades skip
    // CORS entirely (browser CORS rules don't apply to the WS handshake).
    const origin = request.headers.get('Origin')
    const cors = corsHeaders(origin, env)
    if (request.method === 'OPTIONS' && cors) {
      return new Response(null, { status: 204, headers: cors })
    }

    // Maintenance-mode short-circuit (#7 cutover, B-INFRA-4). Operators flip
    // MAINTENANCE_MODE=1 via wrangler secret to drain traffic during the
    // big-bang DB switchover. /login and /api/health stay open so the
    // operator can validate auth + worker health pre-flip.
    if (env.MAINTENANCE_MODE === '1') {
      if (!url.pathname.startsWith('/login') && url.pathname !== '/api/health') {
        const html = `<!DOCTYPE html><html><body><div style="text-align:center;padding:48px;font-family:system-ui"><h1>Migration in progress</h1><p style="color:#666">We're upgrading our storage. Back in about 15 minutes.</p></div></body></html>`
        return new Response(html, { status: 503, headers: { 'content-type': 'text/html' } })
      }
    }

    // PartyKit-style routing for /parties/user-settings/:userId — the
    // browser WS for cache-invalidation fanout (issue #7 p3, B-API-4b).
    // routePartykitRequest kebab-cases the binding name, so USER_SETTINGS
    // is reachable as the `user-settings` party. Auth (cookie userId ==
    // path userId) is enforced inside the DO's onConnect.
    if (url.pathname.startsWith('/parties/')) {
      const partyResp = await routePartykitRequest(
        request,
        env as unknown as Record<string, unknown>,
      )
      if (partyResp) return partyResp
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
      // Spec #68 B9 — non-owners may join a public session's collab WS;
      // admins may join any session. Private sessions stay owner-only.
      const allowed = await checkSessionAccess(env, sessionId, authSession)
      if (!allowed) {
        return new Response('Forbidden', { status: 403 })
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

        // Browser auth: require Better Auth session. The top-level handler
        // has already hoisted `?_authToken` to `Authorization: Bearer` so
        // getRequestSession sees an authenticated request on Capacitor too.
        const authSession = await getRequestSession(env, request)
        if (!authSession) {
          return new Response('Unauthorized', { status: 401 })
        }

        // Spec #68 B8 — non-owners may open the session WS if the session
        // is public, or if the caller is admin. If the D1 row doesn't
        // exist yet (create race), defer the check to the DO.
        const allowed = await checkSessionAccess(env, sessionId, authSession)
        if (!allowed) {
          return new Response('Forbidden', { status: 403 })
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
      const resp = await apiApp.fetch(request, env, ctx)
      if (cors) {
        const merged = new Headers(resp.headers)
        for (const [k, v] of Object.entries(cors)) merged.set(k, v)
        return new Response(resp.body, { status: resp.status, headers: merged })
      }
      return resp
    }

    const assetResponse = await env.ASSETS.fetch(request)
    if (assetResponse.status !== 404) {
      return assetResponse
    }

    return env.ASSETS.fetch(new Request(new URL('/', request.url), request))
  },
  scheduled,
}

export { SessionCollabDO, SessionCollabDOv2, SessionDO, UserSettingsDO }

// Stub: wrangler needs this class exported for the v5 deleted_classes
// migration to apply. Once the migration has run on the infra pipeline's
// first successful deploy, this stub can be removed in a follow-up commit.
export class ProjectRegistry {
  state: DurableObjectState
  env: Env
  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }
  async fetch() {
    return new Response('gone', { status: 410 })
  }
}
