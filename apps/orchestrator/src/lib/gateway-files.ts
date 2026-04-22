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
 * Check the status of a spec file for a given issue number.
 * Returns `{exists:false}` if no spec file matches `<issue>-*.md`, else
 * `{exists:true, status}` parsed from the frontmatter.
 */
export async function getSpecStatus(
  env: Env,
  project: string,
  issueNumber: number,
): Promise<{ exists: boolean; status: string | null }> {
  const entries = await listGatewayFiles(env, project, 'planning/specs')
  if (!entries) return { exists: false, status: null }

  const pattern = new RegExp(`^${issueNumber}-.*\\.md$`)
  const matches = entries.filter((e) => pattern.test(e.name))
  if (matches.length === 0) return { exists: false, status: null }

  matches.sort((a, b) => {
    const ta = a.modified ? new Date(a.modified as string | number).getTime() : 0
    const tb = b.modified ? new Date(b.modified as string | number).getTime() : 0
    return tb - ta
  })
  const winner = matches[0]
  const relPath = winner.path ?? `planning/specs/${winner.name}`

  const content = await fetchGatewayFile(env, project, relPath)
  if (content === null) return { exists: false, status: null }

  const fm = parseFrontmatter(content)
  return { exists: true, status: fm.status ?? null }
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
