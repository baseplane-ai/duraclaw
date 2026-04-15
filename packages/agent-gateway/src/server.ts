import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import * as nodePath from 'node:path'
import type { ServerWebSocket } from 'bun'
import { AdapterRegistry, ClaudeAdapter, CodexAdapter, OpenCodeAdapter } from './adapters/index.js'
import { verifyToken } from './auth.js'
import { handleQueryCommand } from './commands.js'
import { handleFileContents, handleFileTree, handleGitStatus } from './files.js'
import { findLatestKataState } from './kata.js'
import { spec as openapiSpec } from './openapi.js'
import { discoverProjects, resolveProject } from './projects.js'
import {
  ClaudeSessionSource,
  CodexSessionSource,
  OpenCodeSessionSource,
  SessionSourceRegistry,
} from './session-sources/index.js'
import { listSdkSessions } from './sessions-list.js'
import type { GatewayCommand, GatewaySessionContext, WsData } from './types.js'

// ── Adapter Registry ───────────────────────────────────────────────

export const registry = new AdapterRegistry()
registry.register(new ClaudeAdapter())
registry.register(new CodexAdapter())
registry.register(new OpenCodeAdapter())

const sessionSources = new SessionSourceRegistry()
sessionSources.register(new ClaudeSessionSource())
sessionSources.register(new CodexSessionSource())
sessionSources.register(new OpenCodeSessionSource())

const PORT = Number(process.env.CC_GATEWAY_PORT ?? 9877)
const startedAt = Date.now()

// ── Per-Connection Session Tracking ─────────────────────────────────

const sessions = new Map<ServerWebSocket<WsData>, GatewaySessionContext>()

// ── Per-Connection Kata File Watchers ──────────────────────────────

const kataWatchers = new Map<ServerWebSocket<WsData>, FSWatcher>()
const kataDebounceTimers = new Map<ServerWebSocket<WsData>, ReturnType<typeof setTimeout>>()

// ── HTTP Helpers ────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Bun Server ──────────────────────────────────────────────────────

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: '127.0.0.1',

  async fetch(req, server) {
    const url = new URL(req.url)
    const path = url.pathname

    // GET /health — no auth
    if (req.method === 'GET' && path === '/health') {
      return json(200, {
        status: 'ok',
        version: '0.1.0',
        uptime_ms: Date.now() - startedAt,
      })
    }

    // GET /openapi.json — no auth
    if (req.method === 'GET' && path === '/openapi.json') {
      return json(200, openapiSpec)
    }

    // All other routes require auth
    if (!verifyToken(req)) {
      return json(401, { error: 'Unauthorized' })
    }

    // GET /capabilities — list available agents
    if (req.method === 'GET' && path === '/capabilities') {
      const agents = await registry.listCapabilities()
      return json(200, { agents })
    }

    // GET /sessions/discover — discover sessions from all sources across all projects
    if (req.method === 'GET' && path === '/sessions/discover') {
      const since = url.searchParams.get('since') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? 200)
      const projectFilter = url.searchParams.get('project') ?? undefined

      // Discover all projects
      const projects = await discoverProjects({})
      const filtered = projectFilter ? projects.filter((p) => p.name === projectFilter) : projects

      const allSessions: import('./types.js').DiscoveredSession[] = []
      const sourceSummary: Record<string, { available: boolean; session_count: number }> = {}

      // Initialize source summary
      for (const source of sessionSources.listSources()) {
        const avail = await source.available()
        sourceSummary[source.agent] = { available: avail, session_count: 0 }
      }

      // Discover sessions from each source for each project (parallel across projects)
      const projectResults = await Promise.all(
        filtered.map(async (project) => {
          const projectSessions: import('./types.js').DiscoveredSession[] = []
          for (const source of sessionSources.listSources()) {
            if (!sourceSummary[source.agent].available) continue
            try {
              const sessions = await source.discoverSessions(project.path, { since, limit })
              projectSessions.push(...sessions)
              sourceSummary[source.agent].session_count += sessions.length
            } catch (err) {
              console.error(`[session-discover] ${source.agent} failed for ${project.name}:`, err)
            }
          }
          return projectSessions
        }),
      )
      const allDiscovered = projectResults.flat()
      allSessions.push(...allDiscovered)

      // Sort by last_activity descending
      allSessions.sort((a, b) => (b.last_activity > a.last_activity ? 1 : -1))

      return json(200, { sessions: allSessions, sources: sourceSummary })
    }

    // GET /projects
    if (req.method === 'GET' && path === '/projects') {
      return discoverProjects({}).then((projects) => json(200, projects))
    }

    // GET /projects/:name/files?depth=1&path=/ — directory listing
    // GET /projects/:name/files/*path — file contents
    const projectFilesMatch = path.match(/^\/projects\/([^/]+)\/files(?:\/(.+))?$/)
    if (req.method === 'GET' && projectFilesMatch) {
      const [, name, filePath] = projectFilesMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      if (filePath) {
        return handleFileContents(projectPath, filePath)
      }
      return handleFileTree(projectPath, url.searchParams)
    }

    // GET /projects/:name/git-status
    const gitStatusMatch = path.match(/^\/projects\/([^/]+)\/git-status$/)
    if (req.method === 'GET' && gitStatusMatch) {
      const [, name] = gitStatusMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      return handleGitStatus(projectPath)
    }

    // GET /projects/:name/kata-status
    const kataStatusMatch = path.match(/^\/projects\/([^/]+)\/kata-status$/)
    if (req.method === 'GET' && kataStatusMatch) {
      const [, name] = kataStatusMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      const kataState = await findLatestKataState(projectPath)
      return json(200, { kata_state: kataState })
    }

    // GET /projects/:name/sessions
    const sessionsMatch = path.match(/^\/projects\/([^/]+)\/sessions$/)
    if (req.method === 'GET' && sessionsMatch) {
      const [, name] = sessionsMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const sessions = await listSdkSessions(projectPath, limit)
      return json(200, { sessions })
    }

    // GET /projects/:name/sessions/:id/messages — fetch SDK session transcript
    const sessionMessagesMatch = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && sessionMessagesMatch) {
      const [, name, sdkSessionId] = sessionMessagesMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      try {
        const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
        const rawMessages = await getSessionMessages(sdkSessionId, { dir: projectPath })
        // Map SDK messages to gateway event shapes for direct persistence in the DO
        const events = rawMessages
          .filter((m: any) => m.type === 'assistant' || m.type === 'user')
          .map((m: any) => {
            if (m.type === 'assistant') {
              return {
                type: 'assistant' as const,
                session_id: m.session_id,
                uuid: m.uuid,
                content: m.message?.content ?? [],
              }
            }
            return {
              type: 'user' as const,
              session_id: m.session_id,
              uuid: m.uuid,
              content: m.message?.content ?? m.message ?? '',
            }
          })
        return json(200, { messages: events })
      } catch (err) {
        return json(500, {
          error: `Failed to read session messages: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    // GET /projects/:name/sessions/latest
    const latestSessionMatch = path.match(/^\/projects\/([^/]+)\/sessions\/latest$/)
    if (req.method === 'GET' && latestSessionMatch) {
      const [, name] = latestSessionMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      const sessions = await listSdkSessions(projectPath, 1)
      if (sessions.length === 0) {
        return json(404, { error: 'No sessions found' })
      }
      return json(200, sessions[0])
    }

    // POST /projects/:name/sessions/:id/fork
    const forkMatch = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/fork$/)
    if (req.method === 'POST' && forkMatch) {
      const [, name, sessionId] = forkMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      try {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
        const result = await forkSession(sessionId, {
          dir: projectPath,
          upToMessageId: body.up_to_message_id as string | undefined,
          title: body.title as string | undefined,
        })
        return json(200, { session_id: result.sessionId })
      } catch (err) {
        return json(500, {
          error: `Fork failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    // PATCH /projects/:name/sessions/:id
    const patchSessionMatch = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)$/)
    if (req.method === 'PATCH' && patchSessionMatch) {
      const [, name, sessionId] = patchSessionMatch
      const projectPath = await resolveProject(name)
      if (!projectPath) {
        return json(404, { error: `Project "${name}" not found` })
      }
      try {
        const body = (await req.json()) as Record<string, unknown>
        const { renameSession, tagSession } = await import('@anthropic-ai/claude-agent-sdk')
        if (body.title !== undefined) {
          await renameSession(sessionId, body.title as string, { dir: projectPath })
        }
        if (body.tag !== undefined) {
          await tagSession(sessionId, body.tag as string | null, { dir: projectPath })
        }
        return json(200, { ok: true })
      } catch (err) {
        return json(500, {
          error: `Update failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    // WebSocket upgrade
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const project = url.searchParams.get('project') ?? null
      const upgraded = server.upgrade(req, {
        data: { project } satisfies WsData,
      })
      if (upgraded) {
        return undefined // Bun handles the rest
      }
      return json(400, { error: 'WebSocket upgrade failed' })
    }

    return json(404, { error: 'Not found' })
  },

  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      console.log(`[agent-gateway] WS connected (project=${ws.data.project ?? 'none'})`)

      // Start watching kata state for this project
      if (ws.data.project) {
        const projectPath = nodePath.join('/data/projects', ws.data.project)
        const sessionsDir = nodePath.join(projectPath, '.kata', 'sessions')
        try {
          const watcher = watch(sessionsDir, { recursive: true }, (_event, filename) => {
            if (!filename?.endsWith('state.json')) return

            // Debounce to avoid duplicate events from editor write patterns
            const existing = kataDebounceTimers.get(ws)
            if (existing) clearTimeout(existing)
            kataDebounceTimers.set(
              ws,
              setTimeout(() => {
                kataDebounceTimers.delete(ws)
                findLatestKataState(projectPath).then((state) => {
                  try {
                    ws.send(
                      JSON.stringify({
                        type: 'kata_state',
                        session_id: sessions.get(ws)?.sessionId ?? null,
                        project: ws.data.project,
                        kata_state: state,
                      }),
                    )
                  } catch {
                    // WS may have closed between debounce and send
                  }
                })
              }, 150),
            )
          })
          kataWatchers.set(ws, watcher)
        } catch {
          // No .kata/sessions/ dir — skip watching
        }
      }
    },

    async message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      console.log(`[agent-gateway] WS message received: ${String(raw).substring(0, 100)}`)
      let cmd: GatewayCommand
      try {
        cmd = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'))
      } catch {
        ws.send(JSON.stringify({ type: 'error', session_id: null, error: 'Invalid JSON' }))
        return
      }

      switch (cmd.type) {
        case 'resume':
        case 'execute': {
          // Only one session per WS connection
          const existing = sessions.get(ws)
          if (existing) {
            existing.abortController.abort()
            sessions.delete(ws)
          }

          // Resolve adapter
          const agentName = cmd.agent ?? 'claude'
          const adapter = registry.get(agentName)
          if (!adapter) {
            ws.send(
              JSON.stringify({
                type: 'error',
                session_id: null,
                error: `Agent "${agentName}" is not available. Available agents: ${registry.listNames().join(', ')}`,
              }),
            )
            return
          }

          const sessionId = randomUUID()
          const ac = new AbortController()
          const ctx: GatewaySessionContext = {
            sessionId,
            orgId: cmd.type === 'execute' ? (cmd.org_id ?? null) : null,
            userId: cmd.type === 'execute' ? (cmd.user_id ?? null) : null,
            adapterName: agentName,
            abortController: ac,
            pendingAnswer: null,
            pendingPermission: null,
            messageQueue: null,
            query: null,
            commandQueue: [],
          }
          sessions.set(ws, ctx)

          // Run session in background -- don't await so we can receive
          // further messages (abort, answer, stream-input, etc.) on this same WS
          console.log(
            `[agent-gateway] Starting session ${sessionId} for project=${cmd.project} agent=${agentName}`,
          )
          const sessionPromise =
            cmd.type === 'resume' ? adapter.resume(ws, cmd, ctx) : adapter.execute(ws, cmd, ctx)

          sessionPromise
            .then(() => {
              console.log(`[agent-gateway] Session ${sessionId} completed`)
            })
            .catch((err) => {
              console.error(`[agent-gateway] Session ${sessionId} error:`, err)
            })
            .finally(() => {
              sessions.delete(ws)
            })
          break
        }

        case 'stream-input': {
          const ctx = sessions.get(ws)
          if (ctx?.messageQueue) {
            ctx.messageQueue.push(cmd.message)
          } else {
            ws.send(
              JSON.stringify({
                type: 'error',
                session_id: ctx?.sessionId ?? null,
                error: 'No running session to receive messages',
              }),
            )
          }
          break
        }

        case 'permission-response': {
          const ctx = sessions.get(ws)
          if (ctx?.pendingPermission) {
            ctx.pendingPermission.resolve(cmd.allowed)
            ctx.pendingPermission = null
          } else {
            ws.send(
              JSON.stringify({
                type: 'error',
                session_id: ctx?.sessionId ?? null,
                error: 'No pending permission prompt for this session',
              }),
            )
          }
          break
        }

        case 'abort': {
          const ctx = sessions.get(ws)
          if (ctx) {
            ctx.abortController.abort()
            sessions.delete(ws)
          }
          break
        }

        case 'stop': {
          const ctx = sessions.get(ws)
          if (ctx) {
            // Graceful stop: signal abort but send stopped event (session is resumable)
            const sdkSessionId = ctx.sessionId
            ctx.abortController.abort()
            ws.send(
              JSON.stringify({
                type: 'stopped',
                session_id: ctx.sessionId,
                sdk_session_id: sdkSessionId,
              }),
            )
            sessions.delete(ws)
          }
          break
        }

        case 'rewind': {
          const ctx = sessions.get(ws)
          if (ctx?.query) {
            try {
              const result = await ctx.query.rewindFiles(cmd.message_id, { dryRun: cmd.dry_run })
              ws.send(
                JSON.stringify({
                  type: 'rewind_result',
                  session_id: ctx.sessionId,
                  can_rewind: result.canRewind,
                  error: result.error,
                  files_changed: result.filesChanged,
                  insertions: result.insertions,
                  deletions: result.deletions,
                }),
              )
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: 'error',
                  session_id: ctx.sessionId,
                  error: `Rewind failed: ${err instanceof Error ? err.message : String(err)}`,
                }),
              )
            }
          } else {
            ws.send(
              JSON.stringify({
                type: 'error',
                session_id: ctx?.sessionId ?? null,
                error: 'No active session with Query object to rewind',
              }),
            )
          }
          break
        }

        case 'interrupt':
        case 'get-context-usage':
        case 'set-model':
        case 'set-permission-mode': {
          const ctx = sessions.get(ws)
          if (!ctx) {
            ws.send(
              JSON.stringify({
                type: 'error',
                session_id: null,
                error: `No active session for ${cmd.type}`,
              }),
            )
          } else if (ctx.query) {
            await handleQueryCommand(ctx, cmd, ws)
          } else {
            // Queue for when Query becomes available
            ctx.commandQueue.push(cmd)
          }
          break
        }

        case 'stop-task': {
          const ctx = sessions.get(ws)
          if (ctx?.query) {
            await ctx.query.stopTask(cmd.task_id)
          } else {
            ws.send(
              JSON.stringify({
                type: 'error',
                session_id: ctx?.sessionId ?? null,
                error: 'No active session with Query object — cannot stop task',
              }),
            )
          }
          break
        }

        case 'answer': {
          const ctx = sessions.get(ws)
          if (ctx?.pendingAnswer) {
            ctx.pendingAnswer.resolve(cmd.answers)
            ctx.pendingAnswer = null
          } else {
            ws.send(
              JSON.stringify({
                type: 'error',
                session_id: ctx?.sessionId ?? null,
                error: 'No pending question for this session',
              }),
            )
          }
          break
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }))
          break
        }

        default:
          ws.send(
            JSON.stringify({
              type: 'error',
              session_id: null,
              error: `Unknown command type: ${(cmd as any).type}`,
            }),
          )
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      console.log('[agent-gateway] WS disconnected')

      // Clean up kata file watcher
      const watcher = kataWatchers.get(ws)
      if (watcher) {
        watcher.close()
        kataWatchers.delete(ws)
      }
      const timer = kataDebounceTimers.get(ws)
      if (timer) {
        clearTimeout(timer)
        kataDebounceTimers.delete(ws)
      }

      const ctx = sessions.get(ws)
      if (ctx) {
        ctx.abortController.abort()
        if (ctx.pendingAnswer) {
          ctx.pendingAnswer.reject(new Error('WebSocket closed'))
          ctx.pendingAnswer = null
        }
        if (ctx.pendingPermission) {
          ctx.pendingPermission.reject(new Error('WebSocket closed'))
          ctx.pendingPermission = null
        }
        sessions.delete(ws)
      }
    },
  },
})

// ── Startup ─────────────────────────────────────────────────────────

console.log(`[agent-gateway] Initializing on port ${PORT} (pid ${process.pid})`)

discoverProjects({}).then((projects) => {
  console.log(`[agent-gateway] Discovered ${projects.length} projects:`)
  for (const wt of projects) {
    console.log(`  ${wt.name} (${wt.branch}) → ${wt.path}`)
  }
})

console.log(`[agent-gateway] Listening on http://127.0.0.1:${PORT}`)

// ── Graceful Shutdown ───────────────────────────────────────────────

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`\n[agent-gateway] Received ${signal}, shutting down...`)

    // Close all kata file watchers
    for (const [, watcher] of kataWatchers) {
      watcher.close()
    }
    kataWatchers.clear()
    for (const [, timer] of kataDebounceTimers) {
      clearTimeout(timer)
    }
    kataDebounceTimers.clear()

    // Abort all running sessions and close WebSocket connections
    for (const [ws, ctx] of sessions) {
      ctx.abortController.abort()
      if (ctx.pendingAnswer) {
        ctx.pendingAnswer.reject(new Error('Server shutting down'))
        ctx.pendingAnswer = null
      }
      if (ctx.pendingPermission) {
        ctx.pendingPermission.reject(new Error('Server shutting down'))
        ctx.pendingPermission = null
      }
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
    sessions.clear()

    server.stop()
    console.log('[agent-gateway] Server closed')
    process.exit(0)
  })
}
