import fs from 'node:fs/promises'
import path from 'node:path'

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
