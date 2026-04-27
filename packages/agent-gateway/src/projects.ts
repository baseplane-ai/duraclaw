import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { deriveProjectId } from '@duraclaw/shared-types'
import type { PrInfo, ProjectInfo } from './types.js'

const execFileAsync = promisify(execFile)

const PROJECTS_DIR = '/data/projects'
const RAW_PATTERNS = process.env.PROJECT_PATTERNS ?? process.env.WORKTREE_PATTERNS ?? ''
const PROJECT_PREFIXES = RAW_PATTERNS.split(',')
  .map((p) => p.trim())
  .filter(Boolean)

const HIDDEN_PROJECTS = new Set(
  (process.env.HIDDEN_PROJECTS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
)

/**
 * Maximum directory depth under PROJECTS_DIR to scan for git repos.
 * Depth 1 (default legacy behavior) = direct children only.
 * Depth 2 lets us pick up repos nested under container dirs like
 * `/data/projects/packages/<name>`.
 */
const MAX_DEPTH = Math.max(1, Number(process.env.PROJECT_MAX_DEPTH ?? 2))

/** Get current git branch for a directory, or "unknown". */
async function getBranch(dir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
    })
    return stdout.trim()
  } catch {
    return 'unknown'
  }
}

/** Get the git remote origin URL, or null. */
async function getRemoteOrigin(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: dir,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Check if a git working tree has uncommitted changes. */
async function isDirty(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/** Get commits ahead/behind relative to upstream (origin/<branch>). */
async function getAheadBehind(
  dir: string,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`],
      { cwd: dir },
    )
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number)
    return { ahead: ahead || 0, behind: behind || 0 }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

/** PR info cache: key = dir, value = { data, timestamp } */
const prCache = new Map<string, { data: PrInfo | null; ts: number }>()
const PR_CACHE_TTL = 30_000 // 30 seconds

/** Get PR info for the current branch via gh CLI. */
async function getPrInfo(dir: string, branch: string): Promise<PrInfo | null> {
  if (branch === 'main' || branch === 'master' || branch === 'unknown') return null

  const cached = prCache.get(dir)
  if (cached && Date.now() - cached.ts < PR_CACHE_TTL) return cached.data

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--json',
        'number,state,isDraft,statusCheckRollup',
        '--limit',
        '1',
      ],
      { cwd: dir, timeout: 5000 },
    )
    const prs = JSON.parse(stdout) as Array<{
      number: number
      state: string
      isDraft: boolean
      statusCheckRollup: Array<{ status: string; conclusion: string }> | null
    }>
    if (prs.length === 0) {
      prCache.set(dir, { data: null, ts: Date.now() })
      return null
    }
    const pr = prs[0]
    let checks: PrInfo['checks'] = null
    if (pr.statusCheckRollup && pr.statusCheckRollup.length > 0) {
      let pass = 0,
        fail = 0,
        pending = 0
      for (const check of pr.statusCheckRollup) {
        if (
          check.conclusion === 'SUCCESS' ||
          check.conclusion === 'NEUTRAL' ||
          check.conclusion === 'SKIPPED'
        )
          pass++
        else if (
          check.conclusion === 'FAILURE' ||
          check.conclusion === 'ERROR' ||
          check.conclusion === 'TIMED_OUT'
        )
          fail++
        else pending++
      }
      checks = { pass, fail, pending, total: pr.statusCheckRollup.length }
    }
    const info: PrInfo = {
      number: pr.number,
      state: pr.state as PrInfo['state'],
      draft: pr.isDraft,
      checks,
    }
    prCache.set(dir, { data: info, ts: Date.now() })
    return info
  } catch {
    prCache.set(dir, { data: null, ts: Date.now() })
    return null
  }
}

/** Whether a directory contains a `.git` entry (file or dir — supports worktrees). */
async function hasGit(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Walk PROJECTS_DIR up to MAX_DEPTH finding git repos.
 * - Names are relative paths from PROJECTS_DIR (e.g. `duraclaw` or `packages/nanobanana`).
 * - Non-git subdirectories are recursed into (so container dirs like `packages/`
 *   don't hide the repos beneath them).
 * - Hidden entries (dot-prefixed) and HIDDEN_PROJECTS matches are skipped.
 * - PROJECT_PREFIXES is applied to the final relative name so callers can match
 *   either a top-level name or a nested path prefix.
 */
async function walkProjectDirs(): Promise<Array<{ name: string; path: string }>> {
  const found: Array<{ name: string; path: string }> = []

  async function walk(dir: string, depth: number, relName: string): Promise<void> {
    if (depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(dir, entry.name)
      const fullName = relName ? `${relName}/${entry.name}` : entry.name

      // Hidden check: match on full relative name or the leaf segment
      if (HIDDEN_PROJECTS.has(fullName) || HIDDEN_PROJECTS.has(entry.name)) continue

      if (await hasGit(fullPath)) {
        if (
          PROJECT_PREFIXES.length > 0 &&
          !PROJECT_PREFIXES.some((prefix) => fullName.startsWith(prefix))
        )
          continue
        found.push({ name: fullName, path: fullPath })
      } else if (depth < MAX_DEPTH) {
        await walk(fullPath, depth + 1, fullName)
      }
    }
  }

  await walk(PROJECTS_DIR, 1, '')
  return found
}

/**
 * GH#27 P1.1-C: Resolve a stable 16-char projectId for a project.
 *
 * - Prefer the SHA-256-derived ID from the git remote `origin` URL
 *   (deterministic across clones — matches `deriveProjectId` in
 *   `@duraclaw/shared-types`).
 * - Fall back to a persisted UUID at `<projectRoot>/.duraclaw/project-id`
 *   when no origin is configured. Slice to 16 hex chars (strip dashes)
 *   so the locally-minted ID has the same shape as derived IDs — every
 *   downstream consumer (orchestrator, RepoDocumentDO routing, browser
 *   editor) treats projectId as exactly 16 lowercase-hex chars.
 *
 * Idempotent: re-running on the same project returns the same ID
 * (derived path is pure; minted path is read-then-write).
 */
async function resolveProjectId(projectPath: string, originUrl: string | null): Promise<string> {
  if (originUrl) return deriveProjectId(originUrl)

  const idDir = path.join(projectPath, '.duraclaw')
  const idFile = path.join(idDir, 'project-id')

  try {
    const existing = (await fs.readFile(idFile, 'utf8')).trim()
    if (existing) return existing
  } catch {
    // file missing → mint below
  }

  // Mint a fresh ID. crypto.randomUUID() is 36 chars with dashes; the
  // hex digits alone are 32 chars. Slice to 16 to match the shape of
  // derived IDs (sha256 → 16-char hex prefix).
  const minted = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  await fs.mkdir(idDir, { recursive: true })
  await fs.writeFile(idFile, minted, 'utf8')
  return minted
}

/**
 * GH#27 P1.1-C: Compute projectId for a discovered project and
 * PATCH the orchestrator's `/api/projects/:projectId` endpoint with
 * `{ projectName, originUrl }`. The orchestrator upserts the
 * `projectMetadata` row so downstream DO lazy-spawn lookups (B12)
 * always find a record.
 *
 * Failure handling: any fetch / network failure is logged but never
 * thrown — discovery must not depend on orchestrator reachability.
 * The next discovery cycle retries.
 *
 * Returns the resolved projectId so callers (tests + future code)
 * can assert on it.
 */
export async function registerProjectWithOrchestrator(
  projectPath: string,
  originUrl: string | null,
): Promise<string | null> {
  // Bail early when the gateway has no orchestrator URL or runner
  // secret configured. This avoids:
  //   - minting `.duraclaw/project-id` into real repos during local
  //     dev / unit tests where the orchestrator isn't reachable;
  //   - issuing a PATCH that would 401 anyway.
  // Registration resumes automatically once the env vars land
  // (next discovery cycle).
  const workerUrl = process.env.WORKER_PUBLIC_URL ?? ''
  const secret = process.env.DOCS_RUNNER_SECRET ?? ''
  if (!workerUrl || !secret) return null

  const projectId = await resolveProjectId(projectPath, originUrl)
  const projectName = path.basename(projectPath)

  const httpBase = workerUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const url = new URL(`/api/projects/${projectId}`, httpBase)

  try {
    const resp = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ projectName, originUrl }),
    })
    if (!resp.ok) {
      console.warn(
        `[agent-gateway] PATCH /api/projects/${projectId} returned ${resp.status} — orchestrator row not updated`,
      )
    }
  } catch (err) {
    console.warn(
      `[agent-gateway] PATCH /api/projects/${projectId} failed`,
      err instanceof Error ? err.message : err,
    )
  }

  return projectId
}

/**
 * Discover all git repos under /data/projects/ (up to PROJECT_MAX_DEPTH).
 * When PROJECT_PATTERNS is set, only repos whose relative name begins with
 * one of those prefixes are returned.
 */
export async function discoverProjects(
  activeSessions: Record<string, string>, // project_path → session_id
): Promise<ProjectInfo[]> {
  const discovered = await walkProjectDirs()

  const projects = await Promise.all(
    discovered.map(async ({ name, path: fullPath }) => {
      const branch = await getBranch(fullPath)
      const [dirty, repo_origin, aheadBehind, pr] = await Promise.all([
        isDirty(fullPath),
        getRemoteOrigin(fullPath),
        getAheadBehind(fullPath, branch),
        getPrInfo(fullPath, branch),
      ])
      // GH#27 P1.1-C: register the project with the orchestrator.
      // Fire-and-forget — failures are logged inside the helper and
      // never abort discovery.
      void registerProjectWithOrchestrator(fullPath, repo_origin)
      return {
        name,
        path: fullPath,
        branch,
        dirty,
        active_session: activeSessions[fullPath] ?? null,
        repo_origin,
        ahead: aheadBehind.ahead,
        behind: aheadBehind.behind,
        pr,
      } satisfies ProjectInfo
    }),
  )

  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve a project name to its full path, or null.
 * Nested names (e.g. `packages/nanobanana`) are allowed up to MAX_DEPTH segments.
 * Path traversal (`..`, absolute paths) is always rejected.
 */
export async function resolveProject(name: string): Promise<string | null> {
  if (!name || name.startsWith('/') || name.includes('..') || name.includes('\0')) return null

  const segments = name.split('/').filter(Boolean)
  if (segments.length === 0 || segments.length > MAX_DEPTH) return null
  // Reject if any segment is hidden or dot-prefixed
  for (const seg of segments) {
    if (seg.startsWith('.')) return null
  }

  const fullPath = path.join(PROJECTS_DIR, ...segments)
  // Defense-in-depth: ensure we didn't escape PROJECTS_DIR
  if (fullPath !== PROJECTS_DIR && !fullPath.startsWith(`${PROJECTS_DIR}/`)) return null

  if (!(await hasGit(fullPath))) return null

  if (PROJECT_PREFIXES.length > 0 && !PROJECT_PREFIXES.some((prefix) => name.startsWith(prefix)))
    return null
  if (HIDDEN_PROJECTS.has(name) || HIDDEN_PROJECTS.has(segments[segments.length - 1])) return null

  return fullPath
}
