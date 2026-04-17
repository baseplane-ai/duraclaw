import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
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

/**
 * Discover all git repos under /data/projects/.
 * When PROJECT_PATTERNS is set, only repos matching those prefixes are returned.
 */
export async function discoverProjects(
  activeSessions: Record<string, string>, // project_path → session_id
): Promise<ProjectInfo[]> {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
  const projects: ProjectInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (
      PROJECT_PREFIXES.length > 0 &&
      !PROJECT_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
    )
      continue
    if (HIDDEN_PROJECTS.has(entry.name)) continue

    const fullPath = path.join(PROJECTS_DIR, entry.name)

    // Verify it's a git repo
    try {
      await fs.access(path.join(fullPath, '.git'))
    } catch {
      continue
    }

    const branch = await getBranch(fullPath)
    const [dirty, repo_origin, aheadBehind, pr] = await Promise.all([
      isDirty(fullPath),
      getRemoteOrigin(fullPath),
      getAheadBehind(fullPath, branch),
      getPrInfo(fullPath, branch),
    ])
    projects.push({
      name: entry.name,
      path: fullPath,
      branch,
      dirty,
      active_session: activeSessions[fullPath] ?? null,
      repo_origin,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      pr,
    })
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a project name to its full path, or null. */
export async function resolveProject(name: string): Promise<string | null> {
  // Validate name against discovered projects to prevent path traversal
  if (name.includes('/') || name.includes('..')) return null
  const fullPath = path.join(PROJECTS_DIR, name)
  try {
    await fs.access(path.join(fullPath, '.git'))
    // If prefixes are configured, verify project matches one
    if (PROJECT_PREFIXES.length > 0 && !PROJECT_PREFIXES.some((prefix) => name.startsWith(prefix)))
      return null
    if (HIDDEN_PROJECTS.has(name)) return null
    return fullPath
  } catch {
    return null
  }
}
