/**
 * GH#115 P1.3: Gateway auto-discovery sweep.
 *
 * Scans `/data/projects/<name>` clones, classifies each by its HEAD branch
 * + optional `.duraclaw/reservation.json`, and upserts the orchestrator
 * registry via `POST /api/gateway/worktrees/upsert` (Bearer-authed by
 * `CC_GATEWAY_SECRET`).
 *
 * The gateway only OBSERVES clones — it never creates them. Clone
 * bootstrap is an operator gesture (`scripts/setup-clone.sh`); a
 * missing/invalid path is a no-op (registry row left to age out via
 * lastTouchedAt; only operator DELETE prunes it).
 *
 * See planning/specs/115-worktrees-first-class-resource.md
 *   §B-DISCOVERY-1, §B-DISCOVERY-2, §B-DISCOVERY-2b, §B-DISCOVERY-3.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEFAULT_PROJECTS_ROOT = '/data/projects'
const DEFAULT_SWEEP_INTERVAL_MS = 60_000

export interface SweptClone {
  /** Absolute clone path (e.g. /data/projects/duraclaw-dev2). */
  path: string
  /** Observed HEAD branch; null when path missing / non-git. */
  branch: string | null
  /** Reservation classification (B-DISCOVERY-2 / B-DISCOVERY-3). */
  reservedBy: { kind: 'arc' | 'session' | 'manual'; id: string | number } | null
  /** Optional `userId` from .duraclaw/reservation.json. Orchestrator
   *  falls back to CC_DEFAULT_DISCOVERY_OWNER_USER_ID if absent. */
  reservationOwnerUserId?: string
}

interface ReservationFile {
  kind: 'arc' | 'session' | 'manual'
  id: string | number
  userId?: string
}

/**
 * Resolve the default branch for a clone via
 *   git -C <path> symbolic-ref --short refs/remotes/origin/HEAD
 * Strips the `origin/` prefix. Falls back to env CC_DEFAULT_BRANCH or
 * 'main' on failure (HEAD not set, no origin, etc.).
 */
async function resolveDefaultBranch(absPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', absPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { timeout: 5000 },
    )
    const trimmed = stdout.trim()
    if (trimmed.startsWith('origin/')) return trimmed.slice('origin/'.length)
    if (trimmed.length > 0) return trimmed
  } catch {
    // fall through to env fallback
  }
  return process.env.CC_DEFAULT_BRANCH ?? 'main'
}

/** Read HEAD branch via `git rev-parse --abbrev-ref HEAD`. Returns null
 *  on failure (path missing, no .git, corrupt repo, etc.). */
async function readHead(absPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', absPath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000 },
    )
    const trimmed = stdout.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/** Validate a parsed reservation.json shape. */
function isValidReservation(value: unknown): value is ReservationFile {
  if (!value || typeof value !== 'object') return false
  const v = value as { kind?: unknown; id?: unknown; userId?: unknown }
  if (v.kind !== 'arc' && v.kind !== 'session' && v.kind !== 'manual') return false
  if (typeof v.id !== 'string' && typeof v.id !== 'number') return false
  if (typeof v.id === 'string' && v.id.length === 0) return false
  if (v.userId !== undefined && typeof v.userId !== 'string') return false
  return true
}

/**
 * Read & validate `<absPath>/.duraclaw/reservation.json`. Tolerates
 * ENOENT (the common case — no file present) silently. Logs a warning
 * on bad JSON / schema and treats as absent.
 */
async function readReservationFile(absPath: string): Promise<ReservationFile | null> {
  const reservationPath = path.join(absPath, '.duraclaw', 'reservation.json')
  let raw: string
  try {
    raw = await fs.readFile(reservationPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    console.warn(
      `[worktree-sweep] reservation read failed path=${absPath} err=${(err as Error).message}`,
    )
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(
      `[worktree-sweep] reservation parse failed path=${absPath} err=${(err as Error).message}`,
    )
    return null
  }
  if (!isValidReservation(parsed)) {
    console.warn(`[worktree-sweep] reservation schema invalid path=${absPath}`)
    return null
  }
  return parsed
}

/**
 * Classify a single clone path (B-DISCOVERY-2 / B-DISCOVERY-3).
 * Returns null when the path is missing, lacks `.git`, or git fails —
 * the caller logs and skips (B-DISCOVERY-2b — registry row left alone
 * to age out via lastTouchedAt; only operator DELETE prunes it).
 *
 * `defaultBranchCache` (optional) lets a sweep cycle amortise the
 * `git symbolic-ref` shell-out across all clones in one pass; pass an
 * empty Map at the top of `sweepWorktrees` and let it fill on demand.
 * Don't share across sweeps — HEAD can change between runs.
 */
export async function classifyClone(
  absPath: string,
  defaultBranchCache?: Map<string, string>,
): Promise<SweptClone | null> {
  // Cheap up-front existence check: bail if `<path>/.git` is missing.
  try {
    await fs.access(path.join(absPath, '.git'))
  } catch {
    console.warn(`[worktree-sweep] skip path=${absPath} reason=missing_or_invalid`)
    return null
  }

  const branch = await readHead(absPath)
  if (branch === null) {
    console.warn(`[worktree-sweep] skip path=${absPath} reason=missing_or_invalid`)
    return null
  }

  const reservation = await readReservationFile(absPath)
  if (reservation) {
    // Reservation file always wins; default-branch override does NOT apply.
    return {
      path: absPath,
      branch,
      reservedBy: { kind: reservation.kind, id: reservation.id },
      reservationOwnerUserId: reservation.userId,
    }
  }

  // No reservation file → branch heuristic.
  let defaultBranch = defaultBranchCache?.get(absPath)
  if (defaultBranch === undefined) {
    defaultBranch = await resolveDefaultBranch(absPath)
    defaultBranchCache?.set(absPath, defaultBranch)
  }

  if (branch === defaultBranch) {
    return { path: absPath, branch, reservedBy: null }
  }
  return {
    path: absPath,
    branch,
    reservedBy: { kind: 'manual', id: branch },
  }
}

/**
 * Scan `projectsRoot` (depth 1; clones are not nested), classify each
 * direct child, filter out nulls. Direct stat — does NOT use
 * `discoverProjects()` from projects.ts (different semantics: that's
 * the manifest path with depth + pattern filtering).
 */
export async function sweepWorktrees(projectsRoot?: string): Promise<SweptClone[]> {
  const root = projectsRoot ?? DEFAULT_PROJECTS_ROOT
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    console.warn(`[worktree-sweep] readdir failed root=${root} err=${(err as Error).message}`)
    return []
  }

  const cache = new Map<string, string>()
  const results: SweptClone[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name === '_pool') continue

    const abs = path.join(root, entry.name)
    const swept = await classifyClone(abs, cache)
    if (swept) results.push(swept)
  }
  return results
}

/**
 * Single-shot sweep + RPC POST `/api/gateway/worktrees/upsert`.
 * Fire-and-forget; never throws. Logs on failure. Used by both the
 * 60s setInterval and the lazy on-spawn caller.
 *
 * Returns `{posted: boolean, cloneCount: number}` for callers/tests
 * that want to inspect the outcome (the periodic timer ignores it).
 */
export async function runWorktreeSweepOnce(opts?: {
  projectsRoot?: string
  workerPublicUrl?: string
  gatewaySecret?: string
}): Promise<{ posted: boolean; cloneCount: number }> {
  const workerPublicUrl = opts?.workerPublicUrl ?? process.env.WORKER_PUBLIC_URL ?? ''
  const gatewaySecret = opts?.gatewaySecret ?? process.env.CC_GATEWAY_SECRET ?? ''

  let clones: SweptClone[] = []
  try {
    clones = await sweepWorktrees(opts?.projectsRoot)
  } catch (err) {
    console.warn(`[worktree-sweep] sweep failed err=${(err as Error).message ?? String(err)}`)
    return { posted: false, cloneCount: 0 }
  }

  if (!workerPublicUrl || !gatewaySecret) {
    // No orchestrator wired up — the local sweep still ran but there's
    // nowhere to push. Mirrors the project-sync behaviour.
    return { posted: false, cloneCount: clones.length }
  }

  const httpBase = workerPublicUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  let url: string
  try {
    url = new URL('/api/gateway/worktrees/upsert', httpBase).toString()
  } catch (err) {
    console.warn(
      `[worktree-sweep] bad WORKER_PUBLIC_URL=${workerPublicUrl} err=${(err as Error).message}`,
    )
    return { posted: false, cloneCount: clones.length }
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gatewaySecret}`,
      },
      body: JSON.stringify({ clones }),
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      console.warn(`[worktree-sweep] upsert returned ${resp.status} — next sweep will retry`)
      // Treat non-2xx as a transient failure we still call "ran"
      // (the local sweep DID complete). Caller doesn't need to retry.
      return { posted: false, cloneCount: clones.length }
    }
  } catch (err) {
    console.warn(
      `[worktree-sweep] upsert fetch failed err=${(err as Error).message ?? String(err)}`,
    )
    return { posted: false, cloneCount: clones.length }
  }

  return { posted: true, cloneCount: clones.length }
}

/**
 * Start the periodic sweep. Returns a `{stop}` handle for the
 * SIGTERM/SIGINT handler. Returns null when disabled (NODE_ENV=test
 * or VITEST=true) — callers can early-exit without bookkeeping.
 *
 * The interval source is `CC_WORKTREE_SWEEP_INTERVAL_MS` (default
 * 60_000). The first pass fires immediately so a brand-new gateway
 * boot doesn't wait a full interval to register clones.
 */
export function startWorktreeSweep(): { stop: () => void } | null {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return null

  const interval = Number(process.env.CC_WORKTREE_SWEEP_INTERVAL_MS ?? DEFAULT_SWEEP_INTERVAL_MS)

  // First pass on startup — non-blocking.
  void runWorktreeSweepOnce()

  const timer = setInterval(() => {
    void runWorktreeSweepOnce()
  }, interval)

  return {
    stop: () => clearInterval(timer),
  }
}
