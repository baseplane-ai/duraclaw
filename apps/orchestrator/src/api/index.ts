import { Hono } from 'hono'
import type { ProjectInfo, SessionSummary } from '~/lib/types'
import { authMiddleware } from './auth-middleware'
import { authRoutes } from './auth-routes'
import type { ApiAppEnv } from './context'

interface CreateSessionBody {
  project?: string
  prompt?: string
  model?: string
  system_prompt?: string
}

type RegistrySession = SessionSummary & {
  userId: string | null
}

function getRegistry(c: { env: ApiAppEnv['Bindings'] }) {
  const registryId = c.env.SESSION_REGISTRY.idFromName('default')
  return c.env.SESSION_REGISTRY.get(registryId) as any
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

  if (session.userId && session.userId !== userId) {
    return { ok: false, status: 403 }
  }

  return { ok: true, session }
}

export function createApiApp() {
  const app = new Hono<ApiAppEnv>()

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.route('/api/auth', authRoutes)
  app.use('/api/*', authMiddleware)

  app.get('/api/projects', async (c) => {
    const userId = c.get('userId')

    try {
      const projects = await fetchGatewayProjects(c.env)
      const registry = getRegistry(c)
      const merged = await Promise.all(
        projects.map(async (project) => ({
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
          userId,
        }),
      }),
    )

    if (!createResponse.ok) {
      return c.json({ error: 'Failed to create session' }, 500)
    }

    const now = new Date().toISOString()
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

    const doId = c.env.SESSION_AGENT.idFromString(ownership.session.id)
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

    const doId = c.env.SESSION_AGENT.idFromString(ownership.session.id)
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
      return c.json(projects)
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
    const doId = c.env.SESSION_AGENT.idFromString(ownership.session.id)
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

    const doId = c.env.SESSION_AGENT.idFromString(ownership.session.id)
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

    return c.json({ status: 'aborted' })
  })

  app.post('/api/sessions/:id/tool-approval', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const body = (await c.req.json()) as { approved?: boolean; toolCallId?: string }
    if (typeof body.toolCallId !== 'string' || typeof body.approved !== 'boolean') {
      return c.json({ error: 'Invalid tool approval payload' }, 400)
    }

    const doId = c.env.SESSION_AGENT.idFromString(ownership.session.id)
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

    const doId = c.env.SESSION_AGENT.idFromString(ownership.session.id)
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
