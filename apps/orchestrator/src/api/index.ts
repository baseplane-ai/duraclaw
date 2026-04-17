import { Hono } from 'hono'
import { validateActionToken } from '~/lib/action-token'
import { createAuth } from '~/lib/auth'
import type {
  ContentBlock,
  DiscoveredSession,
  ProjectInfo,
  SessionSummary,
  UserPreferences,
} from '~/lib/types'
import { authMiddleware } from './auth-middleware'
import { authRoutes } from './auth-routes'
import { getRequestSession } from './auth-session'
import type { ApiAppEnv } from './context'

interface CreateSessionBody {
  project?: string
  prompt?: string | ContentBlock[]
  model?: string
  system_prompt?: string
  sdk_session_id?: string
  agent?: string
}

type RegistrySession = SessionSummary & {
  userId: string | null
}

function getRegistry(c: { env: ApiAppEnv['Bindings'] }) {
  const registryId = c.env.SESSION_REGISTRY.idFromName('default')
  return c.env.SESSION_REGISTRY.get(registryId) as any
}

function getUserSettingsDO(env: ApiAppEnv['Bindings'], userId: string) {
  const doId = env.USER_SETTINGS.idFromName(userId)
  return env.USER_SETTINGS.get(doId)
}

/** Resolve a session ID to a DO ID — hex IDs use idFromString, UUIDs use idFromName */
function getSessionDoId(env: ApiAppEnv['Bindings'], sessionId: string) {
  const isHexId = /^[0-9a-f]{64}$/.test(sessionId)
  return isHexId
    ? env.SESSION_AGENT.idFromString(sessionId)
    : env.SESSION_AGENT.idFromName(sessionId)
}

async function fetchGatewayProjects(env: ApiAppEnv['Bindings']): Promise<ProjectInfo[]> {
  if (!env.CC_GATEWAY_URL) {
    throw new Error('CC_GATEWAY_URL not configured')
  }

  const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const gatewayUrl = new URL('/projects', httpBase)
  const headers: Record<string, string> = {}
  if (env.CC_GATEWAY_SECRET) {
    headers.Authorization = `Bearer ${env.CC_GATEWAY_SECRET}`
  }

  const response = await fetch(gatewayUrl.toString(), { headers })
  if (!response.ok) {
    throw new Error(`Gateway returned ${response.status}`)
  }

  return (await response.json()) as ProjectInfo[]
}

async function resolveProjectPath(
  env: ApiAppEnv['Bindings'],
  projectName: string,
): Promise<string> {
  try {
    const projects = await fetchGatewayProjects(env)
    const match = projects.find((project) => project.name === projectName)
    if (match?.path) {
      return match.path
    }
  } catch {
    // Fall back to the conventional path below.
  }

  return `/data/projects/${projectName}`
}

async function getOwnedSession(
  env: ApiAppEnv['Bindings'],
  sessionId: string,
  userId: string,
): Promise<{ ok: true; session: RegistrySession } | { ok: false; status: 403 | 404 }> {
  const registry = getRegistry({ env })
  const session = (await registry.getSession(sessionId)) as RegistrySession | null

  if (!session) {
    return { ok: false, status: 404 }
  }

  // Ownership check: reject sessions that belong to a different real user.
  // "system" is a placeholder used by the 5-min discovery alarm (which has no
  // user context) — treat those as shared since duraclaw is single-user per VPS.
  if (session.userId && session.userId !== userId && session.userId !== 'system') {
    return { ok: false, status: 403 }
  }

  return { ok: true, session }
}

export function createApiApp() {
  const app = new Hono<ApiAppEnv>()

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.route('/api/auth', authRoutes)

  app.get('/api/push/vapid-key', (c) => {
    const publicKey = c.env.VAPID_PUBLIC_KEY
    if (!publicKey) {
      return c.json({ error: 'Push not configured' }, 503)
    }
    return c.json({ publicKey })
  })

  // Tool approval — supports both session cookie auth AND Bearer action token auth
  // Must be BEFORE authMiddleware because Bearer tokens bypass session auth
  app.post('/api/sessions/:id/tool-approval', async (c) => {
    const sessionId = c.req.param('id')
    const body = (await c.req.json()) as { approved?: boolean; toolCallId?: string }

    if (typeof body.approved !== 'boolean') {
      return c.json({ error: 'Invalid tool approval payload' }, 400)
    }

    // Check for Bearer token auth first (from push notification actions)
    const authHeader = c.req.header('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const result = await validateActionToken(token, c.env.BETTER_AUTH_SECRET)
      if (!result.ok) {
        return c.json({ error: result.error }, 401)
      }

      // Token is valid — use sid/gid from token
      if (result.sid !== sessionId) {
        return c.json({ error: 'Token session mismatch' }, 401)
      }

      const doId = getSessionDoId(c.env, sessionId)
      const sessionDO = c.env.SESSION_AGENT.get(doId)
      const response = await sessionDO.fetch(
        new Request('https://session/tool-approval', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-partykit-room': sessionId,
            'x-user-id': 'action-token',
          },
          body: JSON.stringify({
            approved: body.approved,
            toolCallId: result.gid,
          }),
        }),
      )

      if (!response.ok) {
        return c.json({ error: 'Tool approval failed' }, 400)
      }

      return c.json({ ok: true })
    }

    // Fall back to session cookie auth
    const session = await getRequestSession(c.env, c.req.raw)
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const userId = session.userId

    const ownership = await getOwnedSession(c.env, sessionId, userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    if (typeof body.toolCallId !== 'string') {
      return c.json({ error: 'Invalid tool approval payload' }, 400)
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/tool-approval', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
        body: JSON.stringify({
          approved: body.approved,
          toolCallId: body.toolCallId,
        }),
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Tool approval failed' }, 400)
    }

    return c.json({ ok: true })
  })

  // Token-protected bootstrap endpoint — creates the first admin user.
  // Requires BOOTSTRAP_TOKEN secret. Remove the secret after use to lock down.
  app.post('/api/bootstrap', async (c) => {
    const token = c.env.BOOTSTRAP_TOKEN
    if (!token) {
      return c.json({ error: 'Bootstrap is disabled' }, 403)
    }

    const authHeader = c.req.header('authorization')
    if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== token) {
      return c.json({ error: 'Invalid bootstrap token' }, 401)
    }

    const body = (await c.req.json()) as {
      email?: string
      password?: string
      name?: string
    }
    if (!body.email || !body.password || !body.name) {
      return c.json({ error: 'Missing required fields: email, password, name' }, 400)
    }

    const auth = createAuth(c.env, { allowSignUp: true }) as any
    const result = await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
    })

    if (!result?.user?.id) {
      return c.json({ error: 'Failed to create user' }, 500)
    }

    // Promote to admin
    await c.env.AUTH_DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
      .bind(result.user.id)
      .run()

    return c.json({ ok: true, userId: result.user.id, role: 'admin' })
  })

  app.use('/api/*', authMiddleware)

  // ── User settings (tabs) — proxied to UserSettingsDO ──────────

  app.get('/api/user-settings/tabs', async (c) => {
    const stub = getUserSettingsDO(c.env, c.get('userId'))
    const resp = await stub.fetch(new Request('https://do/tabs'))
    return c.json(await resp.json())
  })

  app.post('/api/user-settings/tabs', async (c) => {
    const body = await c.req.json()
    const stub = getUserSettingsDO(c.env, c.get('userId'))
    const resp = await stub.fetch(
      new Request('https://do/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return c.json(await resp.json())
  })

  app.patch('/api/user-settings/tabs/:id', async (c) => {
    const tabId = c.req.param('id')
    const body = await c.req.json()
    const stub = getUserSettingsDO(c.env, c.get('userId'))
    const resp = await stub.fetch(
      new Request(`https://do/tabs/${tabId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    return c.json(await resp.json())
  })

  app.delete('/api/user-settings/tabs/:id', async (c) => {
    const tabId = c.req.param('id')
    const stub = getUserSettingsDO(c.env, c.get('userId'))
    const resp = await stub.fetch(new Request(`https://do/tabs/${tabId}`, { method: 'DELETE' }))
    return c.json(await resp.json())
  })

  app.get('/api/user/preferences', async (c) => {
    const userId = c.get('userId')
    const result = await c.env.AUTH_DB.prepare(
      'SELECT key, value FROM user_preferences WHERE user_id = ?',
    )
      .bind(userId)
      .all<{ key: string; value: string }>()

    const prefs: Record<string, string> = {}
    for (const row of result.results) {
      prefs[row.key] = row.value
    }
    return c.json(prefs)
  })

  app.put('/api/user/preferences', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as { key?: string; value?: string }

    if (typeof body.key !== 'string' || typeof body.value !== 'string') {
      return c.json({ error: 'Missing required fields: key, value' }, 400)
    }

    await c.env.AUTH_DB.prepare(
      'INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)',
    )
      .bind(userId, body.key, body.value)
      .run()

    return c.json({ ok: true })
  })

  app.get('/api/preferences', async (c) => {
    const userId = c.get('userId')
    const registry = getRegistry(c)
    const prefs = (await registry.getUserPreferences(userId)) as UserPreferences | null
    return c.json(prefs ?? {})
  })

  app.put('/api/preferences', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as Partial<UserPreferences>
    const registry = getRegistry(c)
    await registry.setUserPreferences(userId, body)
    return c.json({ ok: true })
  })

  app.post('/api/push/subscribe', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as {
      endpoint?: string
      keys?: { p256dh?: string; auth?: string }
    }

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return c.json({ error: 'Missing required fields: endpoint, keys.p256dh, keys.auth' }, 400)
    }

    try {
      new URL(body.endpoint)
    } catch {
      return c.json({ error: 'Invalid endpoint URL' }, 400)
    }

    const id = crypto.randomUUID()
    const userAgent = c.req.header('user-agent') ?? null

    await c.env.AUTH_DB.prepare(
      `INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES (
         COALESCE((SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?), ?),
         ?, ?, ?, ?, ?
       )`,
    )
      .bind(
        userId,
        body.endpoint,
        id,
        userId,
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        userAgent,
      )
      .run()

    return c.json({ ok: true }, 201)
  })

  app.post('/api/push/unsubscribe', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as { endpoint?: string }

    if (!body.endpoint) {
      return c.json({ error: 'Missing required field: endpoint' }, 400)
    }

    await c.env.AUTH_DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .bind(userId, body.endpoint)
      .run()

    return c.body(null, 204)
  })

  app.get('/api/projects', async (c) => {
    const userId = c.get('userId')

    try {
      const projects = await fetchGatewayProjects(c.env)

      // Filter out user-hidden projects
      const hiddenResult = await c.env.AUTH_DB.prepare(
        "SELECT value FROM user_preferences WHERE user_id = ? AND key = 'hidden_projects'",
      )
        .bind(userId)
        .first<{ value: string }>()
      const hiddenSet = new Set(
        hiddenResult?.value ? (JSON.parse(hiddenResult.value) as string[]) : [],
      )
      const visibleProjects =
        hiddenSet.size > 0 ? projects.filter((p) => !hiddenSet.has(p.name)) : projects

      const registry = getRegistry(c)
      const merged = await Promise.all(
        visibleProjects.map(async (project) => ({
          ...project,
          sessions: (await registry.listSessionsByProject(
            project.name,
            userId,
          )) as SessionSummary[],
        })),
      )

      return c.json({ projects: merged })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway unreachable'
      return c.json({ error: message }, 502)
    }
  })

  app.get('/api/sessions', async (c) => {
    const sessions = (await getRegistry(c).listSessions(c.get('userId'))) as SessionSummary[]
    return c.json({ sessions })
  })

  app.get('/api/sessions/active', async (c) => {
    const sessions = (await getRegistry(c).listActiveSessions(c.get('userId'))) as SessionSummary[]
    return c.json({ sessions })
  })

  app.get('/api/sessions/search', async (c) => {
    const q = c.req.query('q')
    if (!q) return c.json({ sessions: [] })
    const sessions = (await getRegistry(c).searchSessions(c.get('userId'), q)) as SessionSummary[]
    return c.json({ sessions })
  })

  app.get('/api/sessions/history', async (c) => {
    const registry = getRegistry(c)
    const result = await registry.listSessionsPaginated(c.get('userId'), {
      sortBy: (c.req.query('sortBy') as any) || undefined,
      sortDir: (c.req.query('sortDir') as any) || undefined,
      status: c.req.query('status') || undefined,
      project: c.req.query('project') || undefined,
      model: c.req.query('model') || undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
    })
    return c.json(result)
  })

  app.post('/api/sessions/backfill', async (c) => {
    const registry = getRegistry(c)
    const remaining = await registry.backfillLastActivity()
    return c.json({ ok: true, remaining_null: remaining })
  })

  app.post('/api/sessions/sync', async (c) => {
    const userId = c.get('userId')

    if (!c.env.CC_GATEWAY_URL) {
      return c.json({ error: 'CC_GATEWAY_URL not configured' }, 500)
    }

    const httpBase = c.env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const discoverUrl = new URL('/sessions/discover', httpBase)
    const headers: Record<string, string> = {}
    if (c.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${c.env.CC_GATEWAY_SECRET}`
    }

    let sessions: DiscoveredSession[]
    try {
      const resp = await fetch(discoverUrl.toString(), { headers })
      if (!resp.ok) {
        return c.json({ error: `Gateway returned ${resp.status}` }, 502)
      }
      const data = (await resp.json()) as { sessions: DiscoveredSession[] }
      sessions = data.sessions
    } catch {
      return c.json({ error: 'Gateway unreachable' }, 502)
    }

    const registry = getRegistry(c)
    const result = await registry.syncDiscoveredSessions(userId, sessions)
    return c.json(result)
  })

  app.post('/api/sessions', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as CreateSessionBody

    if (!body.project || !body.prompt) {
      return c.json({ error: 'Missing required fields: project, prompt' }, 400)
    }

    const projectPath = await resolveProjectPath(c.env, body.project)
    const registry = getRegistry(c)

    const doId = c.env.SESSION_AGENT.newUniqueId()
    const sessionId = doId.toString()
    const sessionDO = c.env.SESSION_AGENT.get(doId)

    const createResponse = await sessionDO.fetch(
      new Request('https://session/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': sessionId,
          'x-user-id': userId,
        },
        body: JSON.stringify({
          project: body.project,
          project_path: projectPath,
          prompt: body.prompt,
          model: body.model,
          system_prompt: body.system_prompt,
          sdk_session_id: body.sdk_session_id,
          agent: body.agent,
          userId,
        }),
      }),
    )

    if (!createResponse.ok) {
      return c.json({ error: 'Failed to create session' }, 500)
    }

    const now = new Date().toISOString()

    // When resuming a discovered session, replace the old entry instead of creating a duplicate
    if (body.sdk_session_id) {
      const existing = await registry.findSessionBySdkId(body.sdk_session_id)
      if (existing) {
        await registry.replaceSessionForResume(existing.id, {
          id: sessionId,
          userId,
          project: body.project,
          status: 'running',
          model: body.model ?? existing.model ?? null,
          created_at: existing.created_at ?? now,
          updated_at: now,
          prompt: existing.prompt ?? body.prompt,
          sdk_session_id: body.sdk_session_id,
          title: existing.title,
          summary: existing.summary,
          tag: existing.tag,
          agent: body.agent ?? existing.agent,
        } as any)
        return c.json({ session_id: sessionId }, 201)
      }
    }

    await registry.registerSession({
      id: sessionId,
      userId,
      project: body.project,
      status: 'running',
      model: body.model ?? null,
      created_at: now,
      updated_at: now,
      prompt: body.prompt,
    })

    return c.json({ session_id: sessionId }, 201)
  })

  app.get('/api/sessions/:id', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/state', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }

    const session = await response.json()
    return c.json({ session })
  })

  app.get('/api/sessions/:id/messages', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/messages', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }

    const messages = await response.json()
    return c.json({ messages })
  })

  app.patch('/api/sessions/:id', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const body = (await c.req.json()) as Record<string, unknown>
    const registry = getRegistry(c)
    await registry.updateSession(ownership.session.id, body)
    return c.json({ ok: true })
  })

  app.get('/api/gateway/projects', async (c) => {
    try {
      const projects = await fetchGatewayProjects(c.env)

      // Filter out user-hidden projects
      const userId = c.get('userId')
      const hiddenResult = await c.env.AUTH_DB.prepare(
        "SELECT value FROM user_preferences WHERE user_id = ? AND key = 'hidden_projects'",
      )
        .bind(userId)
        .first<{ value: string }>()
      const hiddenSet = new Set(
        hiddenResult?.value ? (JSON.parse(hiddenResult.value) as string[]) : [],
      )
      const filtered =
        hiddenSet.size > 0 ? projects.filter((p) => !hiddenSet.has(p.name)) : projects

      return c.json(filtered)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway unreachable'
      return c.json({ error: message }, 502)
    }
  })

  app.get('/api/gateway/projects/all', async (c) => {
    try {
      const projects = await fetchGatewayProjects(c.env)

      const userId = c.get('userId')
      const hiddenResult = await c.env.AUTH_DB.prepare(
        "SELECT value FROM user_preferences WHERE user_id = ? AND key = 'hidden_projects'",
      )
        .bind(userId)
        .first<{ value: string }>()
      const hiddenNames: string[] = hiddenResult?.value ? JSON.parse(hiddenResult.value) : []
      const hiddenSet = new Set(hiddenNames)

      return c.json(projects.map((p) => ({ ...p, hidden: hiddenSet.has(p.name) })))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway unreachable'
      return c.json({ error: message }, 502)
    }
  })

  app.post('/api/sessions/:id/fork', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const body = (await c.req.json()) as { up_to_message_id?: string; title?: string }
    const projectName = ownership.session.project
    const httpBase = (c.env.CC_GATEWAY_URL ?? '')
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
    if (!httpBase) {
      return c.json({ error: 'Gateway not configured' }, 502)
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (c.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${c.env.CC_GATEWAY_SECRET}`
    }

    // Find the SDK session ID from the SessionDO state
    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const stateResp = await sessionDO.fetch(
      new Request('https://session/state', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )
    if (!stateResp.ok) {
      return c.json({ error: 'Could not read session state' }, 500)
    }
    const sessionState = (await stateResp.json()) as { sdk_session_id?: string }
    const sdkSessionId = sessionState.sdk_session_id
    if (!sdkSessionId) {
      return c.json({ error: 'Session has no SDK session ID — cannot fork' }, 400)
    }

    const gatewayUrl = new URL(
      `/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sdkSessionId)}/fork`,
      httpBase,
    )

    const response = await fetch(gatewayUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        up_to_message_id: body.up_to_message_id,
        title: body.title,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      return c.json({ error: `Fork failed: ${text}` }, response.status as any)
    }

    const result = (await response.json()) as { session_id: string }
    return c.json({ session_id: result.session_id })
  })

  app.post('/api/sessions/:id/abort', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/abort', {
        method: 'POST',
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Abort failed' }, response.status === 403 ? 403 : 400)
    }

    return c.json({ status: 'idle' })
  })

  app.post('/api/sessions/:id/answers', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const body = (await c.req.json()) as {
      answers?: Record<string, string>
      toolCallId?: string
    }
    if (!body.answers || typeof body.answers !== 'object') {
      return c.json({ error: 'Invalid answers payload' }, 400)
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
        body: JSON.stringify({
          answers: body.answers,
          ...(typeof body.toolCallId === 'string' ? { toolCallId: body.toolCallId } : {}),
        }),
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Submitting answers failed' }, 400)
    }

    return c.json({ ok: true })
  })

  return app
}
