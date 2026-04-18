import { type FSWatcher, watch } from 'node:fs'
import nodePath from 'node:path'
import type { ServerWebSocket } from 'bun'
import { verifyToken } from './auth.js'
import { handleFileContents, handleFileTree, handleGitStatus } from './files.js'
import {
  handleListSessions,
  handleStartSession,
  handleStatus,
  logStatusUnauthorized,
} from './handlers.js'
import { findLatestKataState } from './kata.js'
import { spec as openapiSpec } from './openapi.js'
import { discoverProjects, resolveProject } from './projects.js'
import { getOrCreateReaper, startReaper, stopReaper } from './reaper.js'
import type { WsData } from './types.js'

/** Decode a captured project-name URL segment (e.g. `packages%2Fnanobanana`). */
function decodeProjectName(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

// ── Config ──────────────────────────────────────────────────────────

// GH#8: portless injects PORT when the gateway runs under
// `portless gateway.duraclaw <cmd>`. Honour it first so stable-subdomain dev
// works without editing the systemd unit. Falls back to CC_GATEWAY_PORT for
// the prod/direct path, then to 9877 as the legacy default.
const PORT = Number(process.env.PORT ?? process.env.CC_GATEWAY_PORT ?? 9877)
const startedAt = Date.now()

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
      // Emit a structured log line when the status endpoint is hit without
      // valid auth — downstream log processors key off this shape.
      const statusUnauthMatch = path.match(/^\/sessions\/([^/]+)\/status$/)
      if (req.method === 'GET' && statusUnauthMatch) {
        logStatusUnauthorized(statusUnauthMatch[1])
      }
      return json(401, { ok: false, error: 'unauthorized' })
    }

    // GET /sessions — list all known sessions (B5b)
    if (req.method === 'GET' && path === '/sessions') {
      return handleListSessions()
    }

    // GET /sessions/:id/status (B5)
    const statusMatch = path.match(/^\/sessions\/([^/]+)\/status$/)
    if (req.method === 'GET' && statusMatch) {
      const [, id] = statusMatch
      return handleStatus(id)
    }

    // POST /sessions/start — spawn detached session-runner (B4)
    if (req.method === 'POST' && path === '/sessions/start') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return json(400, { ok: false, error: 'invalid body' })
      }
      return handleStartSession(body, { logger: console })
    }

    // POST /debug/reap — dev-only on-demand reaper trigger (B6). Guarded by
    // DURACLAW_DEBUG_ENDPOINTS=1 so production deploys never expose it.
    if (
      req.method === 'POST' &&
      path === '/debug/reap' &&
      process.env.DURACLAW_DEBUG_ENDPOINTS === '1'
    ) {
      try {
        const report = await getOrCreateReaper().reapOnce()
        return json(200, { ok: true, report })
      } catch (err) {
        return json(500, {
          ok: false,
          error: `reap failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    // GET /projects
    if (req.method === 'GET' && path === '/projects') {
      return discoverProjects({}).then((projects) => json(200, projects))
    }

    // GET /projects/:name/files?depth=1&path=/ — directory listing
    // GET /projects/:name/files/*path — file contents
    const projectFilesMatch = path.match(/^\/projects\/([^/]+)\/files(?:\/(.+))?$/)
    if (req.method === 'GET' && projectFilesMatch) {
      const [, rawName, filePath] = projectFilesMatch
      const name = decodeProjectName(rawName)
      const projectPath = name ? await resolveProject(name) : null
      if (!projectPath) {
        return json(404, { error: `Project "${name ?? rawName}" not found` })
      }
      if (filePath) {
        return handleFileContents(projectPath, filePath)
      }
      return handleFileTree(projectPath, url.searchParams)
    }

    // GET /projects/:name/git-status
    const gitStatusMatch = path.match(/^\/projects\/([^/]+)\/git-status$/)
    if (req.method === 'GET' && gitStatusMatch) {
      const [, rawName] = gitStatusMatch
      const name = decodeProjectName(rawName)
      const projectPath = name ? await resolveProject(name) : null
      if (!projectPath) {
        return json(404, { error: `Project "${name ?? rawName}" not found` })
      }
      return handleGitStatus(projectPath)
    }

    // GET /projects/:name/kata-status
    const kataStatusMatch = path.match(/^\/projects\/([^/]+)\/kata-status$/)
    if (req.method === 'GET' && kataStatusMatch) {
      const [, rawName] = kataStatusMatch
      const name = decodeProjectName(rawName)
      const projectPath = name ? await resolveProject(name) : null
      if (!projectPath) {
        return json(404, { error: `Project "${name ?? rawName}" not found` })
      }
      const kataState = await findLatestKataState(projectPath)
      return json(200, { kata_state: kataState })
    }

    // GET /projects/:name/sessions/:id/messages — fetch SDK session transcript
    const sessionMessagesMatch = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && sessionMessagesMatch) {
      const [, rawName, sdkSessionId] = sessionMessagesMatch
      const name = decodeProjectName(rawName)
      const projectPath = name ? await resolveProject(name) : null
      if (!projectPath) {
        return json(404, { error: `Project "${name ?? rawName}" not found` })
      }
      try {
        const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
        const rawMessages = await getSessionMessages(sdkSessionId, { dir: projectPath })
        // Map SDK messages to gateway event shapes for direct persistence in the DO.
        // User messages may contain tool_result blocks (Claude API format) — split those
        // into separate tool_result events so the DO can apply them to tool parts.
        const events: Array<Record<string, unknown>> = []
        for (const m of rawMessages.filter(
          (m: any) => m.type === 'assistant' || m.type === 'user',
        )) {
          if ((m as any).type === 'assistant') {
            events.push({
              type: 'assistant' as const,
              session_id: (m as any).session_id,
              uuid: (m as any).uuid,
              content: (m as any).message?.content ?? [],
            })
            continue
          }

          // User message — separate tool_result blocks from text/image blocks
          const content = (m as any).message?.content ?? (m as any).message ?? ''
          if (Array.isArray(content)) {
            const toolResultBlocks = content.filter((b: any) => b?.type === 'tool_result')
            const otherBlocks = content.filter((b: any) => b?.type !== 'tool_result')

            if (otherBlocks.length > 0) {
              events.push({
                type: 'user' as const,
                session_id: (m as any).session_id,
                uuid: (m as any).uuid,
                content: otherBlocks,
              })
            }

            if (toolResultBlocks.length > 0) {
              events.push({
                type: 'tool_result' as const,
                session_id: (m as any).session_id,
                uuid: (m as any).uuid,
                content: toolResultBlocks,
              })
            }
          } else {
            events.push({
              type: 'user' as const,
              session_id: (m as any).session_id,
              uuid: (m as any).uuid,
              content,
            })
          }
        }
        return json(200, { messages: events })
      } catch (err) {
        return json(500, {
          error: `Failed to read session messages: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    // POST /projects/:name/sessions/:id/fork
    const forkMatch = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)\/fork$/)
    if (req.method === 'POST' && forkMatch) {
      const [, rawName, sessionId] = forkMatch
      const name = decodeProjectName(rawName)
      const projectPath = name ? await resolveProject(name) : null
      if (!projectPath) {
        return json(404, { error: `Project "${name ?? rawName}" not found` })
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
      const [, rawName, sessionId] = patchSessionMatch
      const name = decodeProjectName(rawName)
      const projectPath = name ? await resolveProject(name) : null
      if (!projectPath) {
        return json(404, { error: `Project "${name ?? rawName}" not found` })
      }
      try {
        const body = (await req.json()) as Record<string, unknown>
        const { renameSession, tagSession } = await import('@anthropic-ai/claude-agent-sdk')
        if (body.title !== undefined) {
          await renameSession(sessionId, body.title as string, { dir: projectPath })
        }
        if (body.tag !== undefined) {
          await tagSession(sessionId, body.tag as any, { dir: projectPath })
        }
        return json(200, { ok: true })
      } catch (err) {
        return json(500, {
          error: `Update failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }

    // WebSocket upgrade — kata state watching only (no session data path).
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

      if (ws.data.project) {
        const projectPath = nodePath.join('/data/projects', ws.data.project)
        const sessionsDir = nodePath.join(projectPath, '.kata', 'sessions')
        try {
          const watcher = watch(sessionsDir, { recursive: true }, (_event, filename) => {
            if (!filename?.endsWith('state.json')) return

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
                        session_id: null,
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
      // Direct-WS surface is kata-state-only now. Ack pings; ignore rest.
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8')) as {
          type?: unknown
        }
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
        }
      } catch {
        /* malformed frame */
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      console.log('[agent-gateway] WS disconnected')

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

// Start the reaper (B6). Runs one pass immediately, then every 5 minutes.
// Skip under test runs so importing server.ts from vitest doesn't schedule
// a background interval.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  startReaper()
  console.log('[agent-gateway] Reaper started')
}

// ── Graceful Shutdown ───────────────────────────────────────────────

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`\n[agent-gateway] Received ${signal}, shutting down...`)

    for (const [, watcher] of kataWatchers) {
      watcher.close()
    }
    kataWatchers.clear()
    for (const [, timer] of kataDebounceTimers) {
      clearTimeout(timer)
    }
    kataDebounceTimers.clear()

    stopReaper()

    server.stop()
    console.log('[agent-gateway] Server closed')
    process.exit(0)
  })
}
