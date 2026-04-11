import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { FileEntry, GitFileStatus } from '@duraclaw/shared-types'

const execFileAsync = promisify(execFile)

const MAX_FILE_SIZE = 1 * 1024 * 1024 // 1MB

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.xml': 'text/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
}

/**
 * Validate that a file path does not escape the project root.
 * Returns the resolved absolute path or null if invalid.
 */
function safePath(projectPath: string, relativePath: string): string | null {
  // Reject paths with .. segments
  if (relativePath.includes('..')) return null
  const resolved = path.resolve(projectPath, relativePath)
  if (!resolved.startsWith(`${projectPath}/`) && resolved !== projectPath) return null
  return resolved
}

/**
 * GET /projects/:name/files?depth=1&path=/
 * Returns directory entries at the given path with optional depth.
 */
export async function handleFileTree(
  projectPath: string,
  searchParams: URLSearchParams,
): Promise<Response> {
  const subPath = searchParams.get('path') ?? '/'
  const depth = Math.min(Number(searchParams.get('depth') ?? '1'), 5)

  const resolved = safePath(projectPath, subPath === '/' ? '.' : subPath)
  if (!resolved) {
    return json(400, { error: 'Path traversal not allowed' })
  }

  try {
    const entries = await listEntries(resolved, projectPath, depth)
    return json(200, { entries })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return json(404, { error: 'Path not found' })
    }
    return json(500, { error: 'Failed to list directory' })
  }
}

async function listEntries(
  dirPath: string,
  projectRoot: string,
  depth: number,
): Promise<FileEntry[]> {
  if (depth <= 0) return []

  const dirents = await fs.readdir(dirPath, { withFileTypes: true })
  const entries: FileEntry[] = []

  for (const dirent of dirents) {
    // Skip hidden files and common noise directories
    if (dirent.name.startsWith('.') && dirent.name !== '.github') continue
    if (dirent.name === 'node_modules' || dirent.name === 'dist' || dirent.name === '.turbo')
      continue

    const fullPath = path.join(dirPath, dirent.name)
    const relativePath = path.relative(projectRoot, fullPath)

    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: relativePath, type: 'dir' })
    } else if (dirent.isFile()) {
      const stat = await fs.stat(fullPath)
      entries.push({ name: dirent.name, path: relativePath, type: 'file', size: stat.size })
    }
  }

  return entries.sort((a, b) => {
    // Directories first, then alphabetical
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * GET /projects/:name/files/*path
 * Returns raw file contents.
 */
export async function handleFileContents(projectPath: string, filePath: string): Promise<Response> {
  const resolved = safePath(projectPath, filePath)
  if (!resolved) {
    return json(400, { error: 'Path traversal not allowed' })
  }

  try {
    const stat = await fs.stat(resolved)

    if (stat.isDirectory()) {
      return json(400, { error: 'Path is a directory, not a file' })
    }

    if (stat.size > MAX_FILE_SIZE) {
      return json(413, { error: `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE})` })
    }

    const content = await fs.readFile(resolved)
    const ext = path.extname(resolved).toLowerCase()
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': contentType },
    })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return json(404, { error: 'File not found' })
    }
    return json(500, { error: 'Failed to read file' })
  }
}

/**
 * GET /projects/:name/git-status
 * Returns per-file git status for the project.
 */
export async function handleGitStatus(projectPath: string): Promise<Response> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: projectPath,
    })

    const files: GitFileStatus[] = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const x = line[0] // index status
        const y = line[1] // working tree status
        const filePath = line.slice(3).trim()

        let status: GitFileStatus['status']
        if (x === '?' && y === '?') {
          status = 'untracked'
        } else if (x !== ' ' && y === ' ') {
          status = 'staged'
        } else {
          status = 'modified'
        }

        return { path: filePath, status }
      })

    return json(200, { files })
  } catch {
    return json(500, { error: 'Failed to get git status' })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
