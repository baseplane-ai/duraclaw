import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import {
  defaultLivenessCheck,
  getSessionsDir,
  type LivenessCheck,
  resolveSessionState,
} from './session-state.js'
import { listSessions } from './sessions-list.js'
import type { GatewayCommand } from './types.js'

// ── HTTP helper ─────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Command validation (B4) ─────────────────────────────────────────

/**
 * Cheap runtime shape check. Matches the surface area the existing handler
 * validated (non-null, has string `type`). Deeper per-type validation lives
 * in session-runner where the SDK actually runs.
 */
export function isValidGatewayCommand(x: unknown): x is GatewayCommand {
  if (!x || typeof x !== 'object') return false
  const t = (x as { type?: unknown }).type
  return typeof t === 'string' && t.length > 0
}

// ── Spawn indirection (testable) ────────────────────────────────────

/** Shape of the spawn function used by the /sessions/start handler. */
export type SpawnFn = (
  bin: string,
  args: string[],
  options: { stdio: ('ignore' | number)[]; detached: true; env: Record<string, string> },
) => { unref: () => void; pid?: number }

export const defaultSpawn: SpawnFn = (bin, args, options) => {
  const child = spawn(bin, args, {
    stdio: options.stdio as unknown as Parameters<typeof spawn>[2]['stdio'],
    detached: options.detached,
    env: options.env,
  })
  return {
    unref: () => child.unref(),
    pid: child.pid ?? undefined,
  }
}

/**
 * Build a clean environment for the session-runner child. Strips
 * CLAUDECODE* so the SDK running inside the runner doesn't detect a nested
 * session. Inlined here since it has a single caller now.
 */
export function buildCleanEnv(): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('CLAUDECODE')) continue
    if (key === 'CLAUDE_CODE_ENTRYPOINT') continue
    clean[key] = value
  }
  return clean
}

// ── Session-runner bin resolution ──────────────────────────────────

let cachedBin: string | null = null

/**
 * Locate `@duraclaw/session-runner/dist/main.js` by walking up from
 * `startDir` through `node_modules/@duraclaw/session-runner/dist/main.js`
 * at each level. Cached after first success. Overridable via
 * `SESSION_RUNNER_BIN` (absolute path).
 */
export async function findSessionRunnerBin(startDir: string): Promise<string | null> {
  const envOverride = process.env.SESSION_RUNNER_BIN
  if (envOverride) {
    try {
      await fs.access(envOverride)
      return envOverride
    } catch {
      return null
    }
  }

  if (cachedBin) return cachedBin

  const rel = nodePath.join('node_modules', '@duraclaw', 'session-runner', 'dist', 'main.js')
  let dir = startDir
  for (;;) {
    const candidate = nodePath.join(dir, rel)
    try {
      await fs.access(candidate)
      cachedBin = candidate
      return candidate
    } catch {
      /* not here — walk up */
    }
    const parent = nodePath.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ── POST /sessions/start (B4) ───────────────────────────────────────

/** Options injected by tests to avoid real I/O / spawning. */
export interface StartSessionOpts {
  sessionsDir?: string
  spawnFn?: SpawnFn
  binResolver?: () => Promise<string | null>
  idGenerator?: () => string
}

/**
 * Handle POST /sessions/start. Caller is responsible for bearer auth.
 * Returns 200 synchronously after fork/spawn — never awaits the child.
 */
export async function handleStartSession(
  body: unknown,
  opts: StartSessionOpts = {},
): Promise<Response> {
  if (!body || typeof body !== 'object') {
    return json(400, { ok: false, error: 'invalid body' })
  }
  const b = body as Record<string, unknown>

  const callbackUrl = b.callback_url
  if (
    typeof callbackUrl !== 'string' ||
    callbackUrl.length === 0 ||
    !(callbackUrl.startsWith('ws://') || callbackUrl.startsWith('wss://'))
  ) {
    return json(400, { ok: false, error: 'invalid callback_url' })
  }

  const callbackToken = b.callback_token
  if (typeof callbackToken !== 'string' || callbackToken.length === 0) {
    return json(400, { ok: false, error: 'invalid callback_token' })
  }

  if (!isValidGatewayCommand(b.cmd)) {
    return json(400, { ok: false, error: 'invalid cmd' })
  }
  const cmd = b.cmd

  const sessionId = (opts.idGenerator ?? randomUUID)()
  const dir = opts.sessionsDir ?? getSessionsDir()
  const cmdFile = nodePath.join(dir, `${sessionId}.cmd`)
  const pidFile = nodePath.join(dir, `${sessionId}.pid`)
  const exitFile = nodePath.join(dir, `${sessionId}.exit`)
  const metaFile = nodePath.join(dir, `${sessionId}.meta.json`)
  const logFile = nodePath.join(dir, `${sessionId}.log`)

  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(cmdFile, JSON.stringify(cmd))

  const binResolver =
    opts.binResolver ??
    (() => findSessionRunnerBin(nodePath.dirname(new URL(import.meta.url).pathname)))
  const bin = await binResolver()
  if (!bin) {
    return json(500, { ok: false, error: 'session-runner bin not found' })
  }

  const logHandle = await fs.open(logFile, 'a', 0o600)
  try {
    const spawnFn = opts.spawnFn ?? defaultSpawn
    const child = spawnFn(
      bin,
      [bin, sessionId, cmdFile, callbackUrl, callbackToken, pidFile, exitFile, metaFile],
      {
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        detached: true,
        env: { ...buildCleanEnv(), SESSIONS_DIR: dir },
      },
    )
    child.unref()
  } finally {
    await logHandle.close()
  }

  return json(200, { ok: true, session_id: sessionId })
}

// ── GET /sessions/:id/status (B5) ──────────────────────────────────

export interface GatewayLogger {
  info: (msg: string, ...rest: unknown[]) => void
  warn: (msg: string, ...rest: unknown[]) => void
  error: (msg: string, ...rest: unknown[]) => void
}

export interface StatusHandlerOpts {
  sessionsDir?: string
  isAlive?: LivenessCheck
  logger?: GatewayLogger
  /** Injectable clock for duration measurement (tests). Defaults to performance.now. */
  now?: () => number
}

export async function handleStatus(
  sessionId: string,
  optsOrSessionsDir: StatusHandlerOpts | string = {},
  isAliveLegacy?: LivenessCheck,
): Promise<Response> {
  // Back-compat: old positional signature (sessionId, sessionsDir, isAlive)
  const opts: StatusHandlerOpts =
    typeof optsOrSessionsDir === 'string'
      ? { sessionsDir: optsOrSessionsDir, isAlive: isAliveLegacy }
      : optsOrSessionsDir

  const sessionsDir = opts.sessionsDir ?? getSessionsDir()
  const isAlive = opts.isAlive ?? defaultLivenessCheck
  const logger: GatewayLogger = opts.logger ?? console
  const now = opts.now ?? (() => performance.now())

  const start = now()
  const res = await resolveSessionState(sessionsDir, sessionId, isAlive)

  if (!res.found) {
    const durationMs = Math.round(now() - start)
    logger.info(
      `[gateway] status sessionId=${sessionId} state=null duration_ms=${durationMs} found=false`,
    )
    return json(404, { ok: false, error: 'session not found' })
  }

  const durationMs = Math.round(now() - start)
  logger.info(
    `[gateway] status sessionId=${sessionId} state=${res.state.state} duration_ms=${durationMs} found=true`,
  )
  return json(200, { ok: true, ...res.state })
}

/**
 * Log an unauthorized status-endpoint hit. Called from the server's auth guard
 * when a `/sessions/:id/status` request fails bearer check, so the log line
 * shape stays co-located with the other gateway status logs.
 */
export function logStatusUnauthorized(sessionId: string, logger: GatewayLogger = console): void {
  logger.warn(`[gateway] status unauthorized sessionId=${sessionId}`)
}

// ── GET /sessions (B5b) ─────────────────────────────────────────────

export async function handleListSessions(
  sessionsDir: string = getSessionsDir(),
  isAlive: LivenessCheck = defaultLivenessCheck,
): Promise<Response> {
  const sessions = await listSessions(sessionsDir, isAlive)
  return json(200, { ok: true, sessions })
}
