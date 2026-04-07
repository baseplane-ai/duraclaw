import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import * as nodePath from 'node:path'
import type { ServerWebSocket } from 'bun'
import { verifyToken } from './auth.js'
import { handleFileContents, handleFileTree, handleGitStatus } from './files.js'
import { findLatestKataState } from './kata.js'
import { discoverProjects, resolveProject } from './projects.js'
import { executeSession } from './sessions.js'
import type { GatewayCommand, SessionContext, WsData } from './types.js'

const PORT = Number(process.env.CC_GATEWAY_PORT ?? 9877)
const startedAt = Date.now()

// ── Per-Connection Session Tracking ─────────────────────────────────

const sessions = new Map<ServerWebSocket<WsData>, SessionContext>()

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

    // All other routes require auth
    if (!verifyToken(req)) {
      return json(401, { error: 'Unauthorized' })
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
      console.log(`[cc-gateway] WS connected (project=${ws.data.project ?? 'none'})`)

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
      console.log(`[cc-gateway] WS message received: ${String(raw).substring(0, 100)}`)
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

          const sessionId = randomUUID()
          const ac = new AbortController()
          const ctx: SessionContext = {
            sessionId,
            orgId: cmd.type === 'execute' ? (cmd.org_id ?? null) : null,
            userId: cmd.type === 'execute' ? (cmd.user_id ?? null) : null,
            abortController: ac,
            pendingAnswer: null,
            pendingPermission: null,
            messageQueue: null,
          }
          sessions.set(ws, ctx)

          // Run session in background — don't await so we can receive
          // further messages (abort, answer, stream-input, etc.) on this same WS
          console.log(`[cc-gateway] Starting session ${sessionId} for project=${cmd.project}`)
          executeSession(ws, cmd, ctx)
            .then(() => {
              console.log(`[cc-gateway] Session ${sessionId} completed`)
            })
            .catch((err) => {
              console.error(`[cc-gateway] Session ${sessionId} error:`, err)
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
      console.log('[cc-gateway] WS disconnected')

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

console.log(`[cc-gateway] Initializing on port ${PORT} (pid ${process.pid})`)

discoverProjects({}).then((projects) => {
  console.log(`[cc-gateway] Discovered ${projects.length} projects:`)
  for (const wt of projects) {
    console.log(`  ${wt.name} (${wt.branch}) → ${wt.path}`)
  }
})

console.log(`[cc-gateway] Listening on http://127.0.0.1:${PORT}`)

// ── Graceful Shutdown ───────────────────────────────────────────────

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`\n[cc-gateway] Received ${signal}, shutting down...`)

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
    console.log('[cc-gateway] Server closed')
    process.exit(0)
  })
}
