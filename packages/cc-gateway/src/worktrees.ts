import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeInfo } from './types.js'

const execFileAsync = promisify(execFile)

const PROJECTS_DIR = '/data/projects'
const WORKTREE_PREFIXES = (process.env.WORKTREE_PATTERNS ?? 'baseplane')
  .split(',')
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
 * Discover all worktrees under /data/projects/ matching WORKTREE_PATTERNS.
 * A valid worktree must have a .git directory/file and a package.json.
 */
export async function discoverWorktrees(
  activeSessions: Record<string, string>, // worktree_path → session_id
): Promise<WorktreeInfo[]> {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
  const worktrees: WorktreeInfo[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!WORKTREE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue

    const fullPath = path.join(PROJECTS_DIR, entry.name)

    // Verify it's a git repo with package.json
    try {
      await fs.access(path.join(fullPath, '.git'))
      await fs.access(path.join(fullPath, 'package.json'))
    } catch {
      continue
    }

    const branch = await getBranch(fullPath)
    const dirty = await isDirty(fullPath)
    worktrees.push({
      name: entry.name,
      path: fullPath,
      branch,
      dirty,
      active_session: activeSessions[fullPath] ?? null,
    })
  }

  return worktrees.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a worktree name to its full path, or null. */
export async function resolveWorktree(name: string): Promise<string | null> {
  // Validate name against discovered worktrees to prevent path traversal
  if (name.includes('/') || name.includes('..')) return null
  const fullPath = path.join(PROJECTS_DIR, name)
  try {
    await fs.access(path.join(fullPath, '.git'))
    // Verify it matches a known prefix
    if (!WORKTREE_PREFIXES.some((prefix) => name.startsWith(prefix))) return null
    return fullPath
  } catch {
    return null
  }
}
