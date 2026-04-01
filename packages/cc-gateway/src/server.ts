import { randomUUID } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { verifyToken } from './auth.js'
import { handleFileContents, handleFileTree, handleGitStatus } from './files.js'
import { executeSession } from './sessions.js'
import type { GatewayCommand, SessionContext, WsData } from './types.js'
import { discoverWorktrees, resolveWorktree } from './worktrees.js'

const PORT = Number(process.env.CC_GATEWAY_PORT ?? 9877)
const startedAt = Date.now()

// ── Per-Connection Session Tracking ─────────────────────────────────

const sessions = new Map<ServerWebSocket<WsData>, SessionContext>()

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

    // GET /worktrees
    if (req.method === 'GET' && path === '/worktrees') {
      return discoverWorktrees({}).then((worktrees) => json(200, worktrees))
    }

    // GET /worktrees/:name/files?depth=1&path=/ — directory listing
    // GET /worktrees/:name/files/*path — file contents
    const worktreeFilesMatch = path.match(/^\/worktrees\/([^/]+)\/files(?:\/(.+))?$/)
    if (req.method === 'GET' && worktreeFilesMatch) {
      const [, name, filePath] = worktreeFilesMatch
      const worktreePath = await resolveWorktree(name)
      if (!worktreePath) {
        return json(404, { error: `Worktree "${name}" not found` })
      }
      if (filePath) {
        return handleFileContents(worktreePath, filePath)
      }
      return handleFileTree(worktreePath, url.searchParams)
    }

    // GET /worktrees/:name/git-status
    const gitStatusMatch = path.match(/^\/worktrees\/([^/]+)\/git-status$/)
    if (req.method === 'GET' && gitStatusMatch) {
      const [, name] = gitStatusMatch
      const worktreePath = await resolveWorktree(name)
      if (!worktreePath) {
        return json(404, { error: `Worktree "${name}" not found` })
      }
      return handleGitStatus(worktreePath)
    }

    // WebSocket upgrade
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const worktree = url.searchParams.get('worktree') ?? null
      const upgraded = server.upgrade(req, {
        data: { worktree } satisfies WsData,
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
      console.log(`[cc-gateway] WS connected (worktree=${ws.data.worktree ?? 'none'})`)
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
            abortController: ac,
            pendingAnswer: null,
            pendingPermission: null,
            messageQueue: null,
          }
          sessions.set(ws, ctx)

          // Run session in background — don't await so we can receive
          // further messages (abort, answer, stream-input, etc.) on this same WS
          console.log(`[cc-gateway] Starting session ${sessionId} for worktree=${cmd.worktree}`)
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

discoverWorktrees({}).then((worktrees) => {
  console.log(`[cc-gateway] Discovered ${worktrees.length} worktrees:`)
  for (const wt of worktrees) {
    console.log(`  ${wt.name} (${wt.branch}) → ${wt.path}`)
  }
})

console.log(`[cc-gateway] Listening on http://127.0.0.1:${PORT}`)

// ── Graceful Shutdown ───────────────────────────────────────────────

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`\n[cc-gateway] Received ${signal}, shutting down...`)

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
