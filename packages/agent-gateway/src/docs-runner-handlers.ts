import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { buildCleanEnv, defaultSpawn, type GatewayLogger, type SpawnFn } from './handlers.js'
import { defaultLivenessCheck, type LivenessCheck, resolveSessionState } from './session-state.js'
import type { SessionStateSnapshot } from './types.js'

// ── HTTP helper ─────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Docs-runners dir ────────────────────────────────────────────────

/** Default directory for per-docs-runner control files. */
export const DEFAULT_DOCS_RUNNERS_DIR = '/run/duraclaw/docs-runners'

/** Resolve the effective docs-runners directory from env. */
export function getDocsRunnersDir(): string {
  return process.env.DOCS_RUNNERS_DIR ?? DEFAULT_DOCS_RUNNERS_DIR
}

// ── Docs-runner bin resolution ─────────────────────────────────────

let cachedDocsBin: string | null = null

/**
 * Locate `@duraclaw/docs-runner/dist/main.js` by walking up from
 * `startDir` through `node_modules/@duraclaw/docs-runner/dist/main.js`
 * at each level. Cached after first success. Overridable via
 * `DOCS_RUNNER_BIN` (absolute path).
 */
export async function findDocsRunnerBin(startDir: string): Promise<string | null> {
  const envOverride = process.env.DOCS_RUNNER_BIN
  if (envOverride) {
    try {
      await fs.access(envOverride)
      return envOverride
    } catch {
      return null
    }
  }

  if (cachedDocsBin) return cachedDocsBin

  const rel = nodePath.join('node_modules', '@duraclaw', 'docs-runner', 'dist', 'main.js')
  let dir = startDir
  for (;;) {
    const candidate = nodePath.join(dir, rel)
    try {
      await fs.access(candidate)
      cachedDocsBin = candidate
      return candidate
    } catch {
      /* not here — walk up */
    }
    const parent = nodePath.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ── Path validation ────────────────────────────────────────────────

const PROJECTS_ROOT = '/data/projects'

/**
 * Stat probe injected for tests. Returns whether the path exists and is a
 * directory. Defaults to `fs.stat(p).isDirectory()`.
 */
export type StatFn = (p: string) => Promise<{ isDirectory: () => boolean } | null>

const defaultStat: StatFn = async (p) => {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

/**
 * Validate a docs-worktree path. Must be:
 *  - absolute (`path.isAbsolute`)
 *  - free of `..` segments and NUL bytes
 *  - an existing directory on disk
 *  - prefixed by `/data/projects/<allowed>` for some configured prefix
 *    (or any subdir under `/data/projects/` when `PROJECT_PATTERNS` is unset)
 *
 * Self-contained — does NOT import from `projects.ts` because the input
 * here is a full path rather than a project name.
 */
export async function validateDocsWorktreePath(
  p: string,
  statFn: StatFn = defaultStat,
): Promise<{ ok: true } | { ok: false }> {
  if (typeof p !== 'string' || p.length === 0) return { ok: false }
  if (!nodePath.isAbsolute(p)) return { ok: false }
  if (p.includes('\0')) return { ok: false }
  for (const seg of p.split('/')) {
    if (seg === '..') return { ok: false }
  }

  const stat = await statFn(p)
  if (!stat?.isDirectory()) return { ok: false }

  const raw = process.env.PROJECT_PATTERNS ?? process.env.WORKTREE_PATTERNS ?? ''
  const prefixes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (prefixes.length === 0) {
    if (p !== PROJECTS_ROOT && !p.startsWith(`${PROJECTS_ROOT}/`)) return { ok: false }
    return { ok: true }
  }

  for (const prefix of prefixes) {
    const allowed = `${PROJECTS_ROOT}/${prefix}`
    if (p === allowed || p.startsWith(`${allowed}/`)) {
      return { ok: true }
    }
  }
  return { ok: false }
}

// ── POST /docs-runners/start ───────────────────────────────────────

const PROJECT_ID_RE = /^[0-9a-f]{16}$/

/** Options injected by tests to avoid real I/O / spawning. */
export interface StartDocsRunnerOpts {
  docsRunnersDir?: string
  spawnFn?: SpawnFn
  binResolver?: () => Promise<string | null>
  isAlive?: LivenessCheck
  statFn?: StatFn
  logger?: GatewayLogger
}

/**
 * Handle POST /docs-runners/start. Caller is responsible for bearer auth.
 * Idempotent — if a live pid is already on disk for this projectId, returns
 * 200 `{ already_running: true, pid }` without re-spawning.
 */
export async function handleStartDocsRunner(
  body: unknown,
  opts: StartDocsRunnerOpts = {},
): Promise<Response> {
  const logger = opts.logger ?? { info: () => {}, warn: () => {}, error: () => {} }

  if (!body || typeof body !== 'object') {
    return json(400, { ok: false, error: 'invalid body' })
  }
  const b = body as Record<string, unknown>

  const projectId = b.projectId
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    return json(400, { ok: false, error: 'invalid body' })
  }

  const docsWorktreePath = b.docsWorktreePath
  if (typeof docsWorktreePath !== 'string' || docsWorktreePath.length === 0) {
    return json(400, { ok: false, error: 'invalid body' })
  }

  const bearer = b.bearer
  if (typeof bearer !== 'string' || bearer.length === 0) {
    return json(400, { ok: false, error: 'invalid body' })
  }

  const validity = await validateDocsWorktreePath(docsWorktreePath, opts.statFn)
  if (!validity.ok) {
    return json(400, { ok: false, error: 'docs_worktree_invalid' })
  }

  const dir = opts.docsRunnersDir ?? getDocsRunnersDir()
  const cmdFile = nodePath.join(dir, `${projectId}.cmd`)
  const pidFile = nodePath.join(dir, `${projectId}.pid`)
  const exitFile = nodePath.join(dir, `${projectId}.exit`)
  const metaFile = nodePath.join(dir, `${projectId}.meta.json`)
  const logFile = nodePath.join(dir, `${projectId}.log`)

  // Idempotency: live pid → return without spawning.
  const isAlive = opts.isAlive ?? defaultLivenessCheck
  try {
    const raw = await fs.readFile(pidFile, 'utf8')
    const pidBody = JSON.parse(raw) as { pid?: unknown }
    const pid =
      typeof pidBody?.pid === 'number' && Number.isFinite(pidBody.pid) && pidBody.pid > 0
        ? pidBody.pid
        : null
    if (pid !== null && isAlive(pid)) {
      return json(200, { ok: true, already_running: true, pid })
    }
    // Pid file exists but pid is dead — fall through to re-spawn.
  } catch {
    // No pid file — fresh spawn.
  }

  // Build callbackBase from WORKER_PUBLIC_URL.
  const workerUrl = process.env.WORKER_PUBLIC_URL ?? ''
  if (!workerUrl) {
    return json(500, { ok: false, error: 'worker_public_url_unset' })
  }
  const wsBase = workerUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  const callbackBase = `${wsBase.replace(/\/$/, '')}/parties/repo-document`

  const cmd = {
    type: 'docs-runner' as const,
    projectId,
    docsWorktreePath,
    callbackBase,
    bearer,
  }

  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(cmdFile, JSON.stringify(cmd))

  const binResolver =
    opts.binResolver ??
    (() => findDocsRunnerBin(nodePath.dirname(new URL(import.meta.url).pathname)))
  const bin = await binResolver()
  if (!bin) {
    logger.error(
      `[gateway] /docs-runners/start bin not found projectId=${projectId} — run pnpm install + pnpm --filter @duraclaw/docs-runner build on the deploy tree`,
    )
    return json(500, { ok: false, error: 'docs-runner bin not found' })
  }

  logger.info(
    `[gateway] /docs-runners/start projectId=${projectId} docsWorktreePath=${docsWorktreePath}`,
  )

  const logHandle = await fs.open(logFile, 'a', 0o600)
  try {
    const spawnFn = opts.spawnFn ?? defaultSpawn
    const child = spawnFn(bin, [projectId, cmdFile, pidFile, exitFile, metaFile], {
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      detached: true,
      env: { ...buildCleanEnv(), DOCS_RUNNERS_DIR: dir },
    })
    child.unref()
  } finally {
    await logHandle.close()
  }

  return json(202, { ok: true, pidFile, cmdFile })
}

// ── GET /docs-runners ──────────────────────────────────────────────

const PID_SUFFIX = '.pid'

export interface ListDocsRunnersOpts {
  docsRunnersDir?: string
  isAlive?: LivenessCheck
}

/**
 * Scan the docs-runners directory for `*.pid` files and return a state
 * snapshot per runner. Missing directory → empty array. Reuses the
 * generic `resolveSessionState` resolver (it's neutral on file naming).
 */
export async function handleListDocsRunners(opts: ListDocsRunnersOpts = {}): Promise<Response> {
  const dir = opts.docsRunnersDir ?? getDocsRunnersDir()
  const isAlive = opts.isAlive ?? defaultLivenessCheck

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return json(200, { ok: true, runners: [] })
    throw err
  }

  const ids = entries
    .filter((name) => name.endsWith(PID_SUFFIX))
    .map((name) => name.slice(0, -PID_SUFFIX.length))

  const results = await Promise.all(
    ids.map(async (id) => {
      const res = await resolveSessionState(dir, id, isAlive)
      return res.found ? res.state : null
    }),
  )

  const runners = results.filter((s): s is SessionStateSnapshot => s !== null)
  return json(200, { ok: true, runners })
}

// ── GET /docs-runners/:projectId/files ─────────────────────────────

/** Cap on number of markdown files returned. */
const MAX_FILES = 5000

/** Names of directories to skip during the walk (regardless of depth). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.duraclaw-docs'])

/** Injectable readdir/stat for tests. */
export type ReaddirFn = (
  p: string,
) => Promise<Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>>

export type StatMtimeFn = (p: string) => Promise<{ mtimeMs: number }>

export interface ListDocsFilesOpts {
  statFn?: StatFn
  readdir?: ReaddirFn
  statMtime?: StatMtimeFn
}

const defaultReaddir: ReaddirFn = async (p) => {
  const dirents = await fs.readdir(p, { withFileTypes: true })
  return dirents.map((d) => ({
    name: d.name,
    isDirectory: () => d.isDirectory(),
    isFile: () => d.isFile(),
  }))
}

const defaultStatMtime: StatMtimeFn = async (p) => {
  const s = await fs.stat(p)
  return { mtimeMs: s.mtimeMs }
}

/**
 * Handle GET /docs-runners/:projectId/files. Walks `docsWorktreePath` (passed
 * as a query param because the gateway has no D1 access) and returns all
 * markdown files with mtime. Skips hidden dirs, node_modules, dist, build,
 * .duraclaw-docs. Caps at MAX_FILES.
 */
export async function handleListDocsFiles(
  projectId: string,
  searchParams: URLSearchParams,
  opts: ListDocsFilesOpts = {},
): Promise<Response> {
  if (!PROJECT_ID_RE.test(projectId)) {
    return json(400, { error: 'invalid projectId' })
  }

  const docsWorktreePath = searchParams.get('docsWorktreePath')
  if (!docsWorktreePath) {
    return json(400, { error: 'docs_worktree_path_required' })
  }

  const validity = await validateDocsWorktreePath(docsWorktreePath, opts.statFn)
  if (!validity.ok) {
    return json(400, { error: 'docs_worktree_invalid' })
  }

  const readdir = opts.readdir ?? defaultReaddir
  const statMtime = opts.statMtime ?? defaultStatMtime

  const out: Array<{ relPath: string; lastModified: number }> = []

  // Iterative walk — small call stack for deep trees.
  const stack: string[] = [docsWorktreePath]
  let rootMissing = false

  walk: while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) break
    let dirents: Awaited<ReturnType<ReaddirFn>>
    try {
      dirents = await readdir(dir)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      // ENOENT on the root dir → 404. ENOENT mid-walk (a subdir vanished)
      // is non-fatal — skip it.
      if (code === 'ENOENT') {
        if (dir === docsWorktreePath) {
          rootMissing = true
          break
        }
        continue
      }
      return json(500, { error: 'directory_walk_failed' })
    }

    for (const dirent of dirents) {
      // Skip hidden entries and well-known noise dirs.
      if (dirent.name.startsWith('.')) continue
      if (SKIP_DIRS.has(dirent.name)) continue

      const fullPath = nodePath.join(dir, dirent.name)

      if (dirent.isDirectory()) {
        stack.push(fullPath)
        continue
      }

      if (!dirent.isFile()) continue
      if (!dirent.name.endsWith('.md')) continue

      let mtimeMs: number
      try {
        const s = await statMtime(fullPath)
        mtimeMs = s.mtimeMs
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue
        return json(500, { error: 'directory_walk_failed' })
      }

      const rel = nodePath.relative(docsWorktreePath, fullPath).split(nodePath.sep).join('/')
      out.push({ relPath: rel, lastModified: Math.round(mtimeMs) })

      if (out.length >= MAX_FILES) break walk
    }
  }

  if (rootMissing) {
    return json(404, { error: 'docs_worktree_not_found' })
  }

  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return json(200, { files: out })
}

// ── GET /docs-runners/:projectId/health ────────────────────────────

/** Default health port the docs-runner listens on (see main.ts). */
export const DEFAULT_DOCS_RUNNER_HEALTH_PORT = 9878

/** Timeout for the upstream `/health` fetch — keep snappy so the orchestrator's own 5 s budget is the dominant one. */
const DOCS_HEALTH_FETCH_TIMEOUT_MS = 3_000

export interface DocsRunnerHealthOpts {
  /** Injectable fetcher (tests). Defaults to `globalThis.fetch`. */
  fetcher?: typeof fetch
}

/**
 * Handle GET /docs-runners/:projectId/health. Proxies to the docs-runner's
 * own loopback `/health` endpoint at `127.0.0.1:${healthPort}` (default
 * 9878). The gateway has no config of its own here — the orchestrator
 * passes the configured port via `?healthPort=`.
 *
 * Response semantics:
 *   - upstream 2xx           → forward 200 + body, propagate `X-Docs-Runner-Version`
 *   - upstream non-2xx       → forward status + body
 *   - fetch throw / timeout  → 502 `docs_runner_unreachable`
 */
export async function handleDocsRunnerHealth(
  projectId: string,
  searchParams: URLSearchParams,
  opts: DocsRunnerHealthOpts = {},
): Promise<Response> {
  if (!PROJECT_ID_RE.test(projectId)) {
    return json(400, { error: 'invalid projectId' })
  }

  const portParam = searchParams.get('healthPort')
  let healthPort = DEFAULT_DOCS_RUNNER_HEALTH_PORT
  if (portParam !== null) {
    const parsed = Number.parseInt(portParam, 10)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      return json(400, { error: 'invalid healthPort' })
    }
    healthPort = parsed
  }

  const fetcher = opts.fetcher ?? fetch
  let upstream: Response
  try {
    upstream = await fetcher(`http://127.0.0.1:${healthPort}/health`, {
      signal: AbortSignal.timeout(DOCS_HEALTH_FETCH_TIMEOUT_MS),
    })
  } catch {
    return json(502, { error: 'docs_runner_unreachable' })
  }

  const text = await upstream.text()
  const headers: Record<string, string> = {
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
  }
  const version = upstream.headers.get('x-docs-runner-version')
  if (version) headers['X-Docs-Runner-Version'] = version

  return new Response(text, {
    status: upstream.status,
    headers,
  })
}

// ── GET /docs-runners/:projectId/status ────────────────────────────

export interface DocsRunnerStatusOpts {
  docsRunnersDir?: string
  isAlive?: LivenessCheck
  logger?: GatewayLogger
  /** Injectable clock for duration measurement (tests). */
  now?: () => number
}

/**
 * Resolve docs-runner state by projectId. Returns 200 `{ ok, state }` on
 * hit (running > terminal exit > crashed), 404 on miss, 400 on malformed
 * projectId.
 */
export async function handleDocsRunnerStatus(
  projectId: string,
  opts: DocsRunnerStatusOpts = {},
): Promise<Response> {
  if (!PROJECT_ID_RE.test(projectId)) {
    return json(400, { ok: false, error: 'invalid projectId' })
  }

  const dir = opts.docsRunnersDir ?? getDocsRunnersDir()
  const isAlive = opts.isAlive ?? defaultLivenessCheck
  const logger: GatewayLogger = opts.logger ?? console
  const now = opts.now ?? (() => performance.now())

  const start = now()
  const res = await resolveSessionState(dir, projectId, isAlive)

  if (!res.found) {
    const durationMs = Math.round(now() - start)
    logger.info(
      `[gateway] docs-runner status projectId=${projectId} state=null duration_ms=${durationMs} found=false`,
    )
    return json(404, { ok: false, error: 'docs runner not found' })
  }

  const durationMs = Math.round(now() - start)
  logger.info(
    `[gateway] docs-runner status projectId=${projectId} state=${res.state.state} duration_ms=${durationMs} found=true`,
  )
  return json(200, { ok: true, ...res.state })
}
