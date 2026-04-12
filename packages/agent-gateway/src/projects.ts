import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProjectInfo } from './types.js'

const execFileAsync = promisify(execFile)

const PROJECTS_DIR = '/data/projects'
const RAW_PATTERNS = process.env.PROJECT_PATTERNS ?? process.env.WORKTREE_PATTERNS ?? ''
const PROJECT_PREFIXES = RAW_PATTERNS.split(',')
  .map((p) => p.trim())
  .filter(Boolean)

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

    const fullPath = path.join(PROJECTS_DIR, entry.name)

    // Verify it's a git repo
    try {
      await fs.access(path.join(fullPath, '.git'))
    } catch {
      continue
    }

    const branch = await getBranch(fullPath)
    const dirty = await isDirty(fullPath)
    const repo_origin = await getRemoteOrigin(fullPath)
    projects.push({
      name: entry.name,
      path: fullPath,
      branch,
      dirty,
      active_session: activeSessions[fullPath] ?? null,
      repo_origin,
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
    return fullPath
  } catch {
    return null
  }
}
