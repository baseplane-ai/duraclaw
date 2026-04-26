/**
 * Gateway file helpers — extracted from api/index.ts so server-side callers
 * (auto-advance, API handlers) can read project files via the VPS agent
 * gateway without going through a same-worker HTTP round-trip.
 *
 * All functions degrade gracefully (return null / fallbacks) when the
 * gateway URL is unset or unreachable.
 */

import type { Env, ProjectInfo } from '~/lib/types'

export interface GatewayFileEntry {
  name: string
  path?: string
  type?: string
  modified?: string | number
}

export async function fetchGatewayProjects(env: Env): Promise<ProjectInfo[]> {
  if (!env.CC_GATEWAY_URL) {
    throw new Error('CC_GATEWAY_URL not configured')
  }

  const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const gatewayUrl = new URL('/projects', httpBase)
  const headers: Record<string, string> = {}
  if (env.CC_GATEWAY_SECRET) {
    headers.Authorization = `Bearer ${env.CC_GATEWAY_SECRET}`
  }

  const response = await fetch(gatewayUrl.toString(), { headers })
  if (!response.ok) {
    throw new Error(`Gateway returned ${response.status}`)
  }

  return (await response.json()) as ProjectInfo[]
}

export async function resolveProjectPath(env: Env, projectName: string): Promise<string> {
  try {
    const projects = await fetchGatewayProjects(env)
    const match = projects.find((project) => project.name === projectName)
    if (match?.path) {
      return match.path
    }
  } catch {
    // Fall back to the conventional path below.
  }
  return `/data/projects/${projectName}`
}

/**
 * Read a file from the gateway's project-browse endpoint. Returns null on
 * any gateway error (matches spec "graceful degrade" for spec/VP status).
 */
export async function fetchGatewayFile(
  env: Env,
  projectName: string,
  relPath: string,
): Promise<string | null> {
  if (!env.CC_GATEWAY_URL) return null
  const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const url = new URL(
    `/projects/${encodeURIComponent(projectName)}/files/${relPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
    httpBase,
  )
  const headers: Record<string, string> = {}
  if (env.CC_GATEWAY_SECRET) headers.Authorization = `Bearer ${env.CC_GATEWAY_SECRET}`
  try {
    const resp = await fetch(url.toString(), { headers })
    if (!resp.ok) return null
    return await resp.text()
  } catch {
    return null
  }
}

/** List files under a project-relative directory via the gateway. */
export async function listGatewayFiles(
  env: Env,
  projectName: string,
  dirPath: string,
): Promise<GatewayFileEntry[] | null> {
  if (!env.CC_GATEWAY_URL) return null
  const httpBase = env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const url = new URL(`/projects/${encodeURIComponent(projectName)}/files`, httpBase)
  url.searchParams.set('path', dirPath)
  url.searchParams.set('depth', '1')
  const headers: Record<string, string> = {}
  if (env.CC_GATEWAY_SECRET) headers.Authorization = `Bearer ${env.CC_GATEWAY_SECRET}`
  try {
    const resp = await fetch(url.toString(), { headers })
    if (!resp.ok) return null
    const data = (await resp.json()) as { entries?: GatewayFileEntry[] } | GatewayFileEntry[]
    if (Array.isArray(data)) return data
    return data.entries ?? []
  } catch {
    return null
  }
}

/**
 * Tiny YAML frontmatter parser — handles `---\n<lines>\n---\n` blocks with
 * `key: value` lines. Values are trimmed and stripped of matching outer
 * quotes. Good enough for spec/VP metadata where we only read `status`-style
 * scalars; does not support nested maps or arrays.
 */
export function parseFrontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith('---\n')) return {}
  const end = markdown.indexOf('\n---\n', 4)
  if (end < 0) return {}
  const block = markdown.slice(4, end)
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

/**
 * Resolve the spec file backing a given GitHub issue number.
 *
 * Resolution order — frontmatter wins over filename:
 *
 *   1. Read every `*.md` under `planning/specs/`, parse frontmatter, keep
 *      files whose `github_issue:` matches `issueNumber`. If any match,
 *      pick the latest by mtime. This is the canonical signal — specs
 *      carry `github_issue: N` precisely so the filename can drift.
 *   2. Fallback to filename prefix `^0*${issueNumber}-.*\.md$` (the legacy
 *      contract). The leading-zero wildcard is the fix for the original
 *      bug — Apr-16-batch specs use `0008-…`, `0015-…`, etc., and the
 *      old `^${issueNumber}-` regex never matched them.
 *
 * Returns `{exists:false, status:null, path:null}` when no spec resolves.
 *
 * Cost: when (1) hits — list + N parallel reads + frontmatter parse for
 * every spec (~50 in this repo). Cached 30s on the client; the server
 * holds no cache, so every cold spec-status call pays this. The reads
 * are best-effort: any individual failure drops that candidate but does
 * not abort the resolution.
 */
export async function getSpecStatus(
  env: Env,
  project: string,
  issueNumber: number,
): Promise<{ exists: boolean; status: string | null; path: string | null }> {
  const entries = await listGatewayFiles(env, project, 'planning/specs')
  if (!entries) return { exists: false, status: null, path: null }

  // Only consider .md files. Don't recurse — listGatewayFiles already
  // requested `depth=1`, but defend against gateway implementations that
  // ignore it.
  const mdFiles = entries.filter((e) => e.name.endsWith('.md'))
  if (mdFiles.length === 0) return { exists: false, status: null, path: null }

  // Read every spec's content in parallel. Best-effort: a per-file fetch
  // failure leaves that entry as `null` and is filtered out below.
  const reads = await Promise.all(
    mdFiles.map(async (entry) => {
      const relPath = entry.path ?? `planning/specs/${entry.name}`
      const content = await fetchGatewayFile(env, project, relPath)
      if (content === null) return null
      const fm = parseFrontmatter(content)
      return { entry, relPath, fm }
    }),
  )
  const candidates = reads.filter(
    (r): r is { entry: GatewayFileEntry; relPath: string; fm: Record<string, string> } =>
      r !== null,
  )
  if (candidates.length === 0) return { exists: false, status: null, path: null }

  const mtime = (entry: GatewayFileEntry) =>
    entry.modified ? new Date(entry.modified as string | number).getTime() : 0
  const byMtimeDesc = (a: { entry: GatewayFileEntry }, b: { entry: GatewayFileEntry }) =>
    mtime(b.entry) - mtime(a.entry)

  // Pass 1 — frontmatter `github_issue:` is the canonical signal. Coerce
  // through Number() so `"58"` and `"0058"` both compare to `58`.
  const fmMatches = candidates.filter((c) => {
    const raw = c.fm.github_issue
    if (raw == null || raw === '' || raw === 'null') return false
    return Number(raw) === issueNumber
  })
  if (fmMatches.length > 0) {
    fmMatches.sort(byMtimeDesc)
    const winner = fmMatches[0]
    return {
      exists: true,
      status: winner.fm.status ?? null,
      path: winner.relPath,
    }
  }

  // Pass 2 — filename prefix fallback for specs that pre-date or omit the
  // `github_issue:` frontmatter convention. `^0*${n}-` handles both the
  // bare `42-foo.md` and the zero-padded `0042-foo.md` shapes.
  const namePattern = new RegExp(`^0*${issueNumber}-.*\\.md$`)
  const nameMatches = candidates.filter((c) => namePattern.test(c.entry.name))
  if (nameMatches.length > 0) {
    nameMatches.sort(byMtimeDesc)
    const winner = nameMatches[0]
    return {
      exists: true,
      status: winner.fm.status ?? null,
      path: winner.relPath,
    }
  }

  return { exists: false, status: null, path: null }
}

/**
 * Check the status of a VP evidence file for a given issue number.
 * Returns `{exists:true}` when the file exists and parses as JSON.
 */
export async function getVpStatus(
  env: Env,
  project: string,
  issueNumber: number,
): Promise<{ exists: boolean; passed: boolean | null }> {
  const relPath = `.kata/verification-evidence/vp-${issueNumber}.json`
  const content = await fetchGatewayFile(env, project, relPath)
  if (content === null) return { exists: false, passed: null }
  try {
    const parsed = JSON.parse(content) as { overallPassed?: unknown }
    const passed = typeof parsed.overallPassed === 'boolean' ? parsed.overallPassed : null
    return { exists: true, passed }
  } catch {
    return { exists: false, passed: null }
  }
}
