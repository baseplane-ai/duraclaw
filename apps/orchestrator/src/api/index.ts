import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as schema from '~/db/schema'
import {
  agentSessions,
  auditLog,
  userPreferences,
  userTabs,
  worktreeReservations,
} from '~/db/schema'
import { validateActionToken } from '~/lib/action-token'
import { createAuth } from '~/lib/auth'
import { type PushPayload, sendPushNotification } from '~/lib/push'
import type {
  AgentSessionRow,
  ChainSummary,
  ContentBlock,
  ContextUsage,
  KataSessionState,
  ProjectInfo,
  SpecStatusResponse,
  UserPreferencesRow,
  UserTabRow,
  VpStatusResponse,
  WorktreeReservation,
} from '~/lib/types'
import { authMiddleware } from './auth-middleware'
import { authRoutes } from './auth-routes'
import { getRequestSession } from './auth-session'
import type { ApiAppEnv } from './context'
import { notifyInvalidation } from './notify'

interface CreateSessionBody {
  project?: string
  prompt?: string | ContentBlock[]
  model?: string
  system_prompt?: string
  sdk_session_id?: string
  agent?: string
  /** Optional GH issue number stamp — used by the kanban Start-next /
   *  drag-to-advance flow (GH#16 P3 U3) so the newly spawned session
   *  shows up in its chain immediately, before kata's own sync writes
   *  the value back. */
  kataIssue?: number
}

const ACTIVE_STATUSES = ['running', 'waiting_input', 'waiting_permission'] as const

const SESSION_PATCH_KEYS = new Set([
  'title',
  'summary',
  'tag',
  'status',
  'archived',
  'model',
  'project',
])

const TAB_PATCH_KEYS = new Set(['sessionId', 'position'])

const PREF_PATCH_KEYS = new Set([
  'permissionMode',
  'model',
  'maxBudget',
  'thinkingMode',
  'effort',
  'hiddenProjects',
])

const PERMISSION_MODES = new Set(['default', 'acceptAll', 'acceptEdits', 'plan'])
const THINKING_MODES = new Set(['adaptive', 'off', 'on'])
const EFFORTS = new Set(['low', 'medium', 'high'])

function getDb(env: ApiAppEnv['Bindings']) {
  return drizzle(env.AUTH_DB, { schema })
}

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header against the raw body
 * using HMAC-SHA-256. Workers runtime — uses Web Crypto, not node:crypto.
 *
 * Constant-time comparison is performed manually over the decoded byte arrays
 * (length-mismatched inputs still walk the full loop to avoid leaking length
 * via timing, though they're rejected up front).
 */
async function verifyGithubSignature(
  secret: string,
  header: string | undefined,
  rawBody: string,
): Promise<boolean> {
  if (!header) return false
  const [scheme, hex] = header.split('=')
  if (scheme !== 'sha256' || !hex) return false

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
  const want = new Uint8Array(mac)

  if (hex.length !== want.length * 2) return false
  const got = new Uint8Array(want.length)
  for (let i = 0; i < want.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (!Number.isFinite(byte)) return false
    got[i] = byte
  }

  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= got[i] ^ want[i]
  return diff === 0
}

/** Resolve a session ID to a DO ID — hex IDs use idFromString, UUIDs use idFromName */
function getSessionDoId(env: ApiAppEnv['Bindings'], sessionId: string) {
  const isHexId = /^[0-9a-f]{64}$/.test(sessionId)
  return isHexId
    ? env.SESSION_AGENT.idFromString(sessionId)
    : env.SESSION_AGENT.idFromName(sessionId)
}

async function fetchGatewayProjects(env: ApiAppEnv['Bindings']): Promise<ProjectInfo[]> {
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

async function resolveProjectPath(
  env: ApiAppEnv['Bindings'],
  projectName: string,
): Promise<string> {
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
 * Read the user's hidden-project list. Stored on user_preferences as the
 * `hidden_projects_json` column (JSON-stringified `string[]`). Returns an
 * empty Set if no row exists or the JSON is malformed.
 */
async function getHiddenProjects(env: ApiAppEnv['Bindings'], userId: string): Promise<Set<string>> {
  const db = getDb(env)
  const rows = await db
    .select({ hiddenProjects: userPreferences.hiddenProjects })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1)
  const raw = rows[0]?.hiddenProjects
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'))
    }
  } catch {
    // fall through
  }
  return new Set()
}

async function getOwnedSession(
  env: ApiAppEnv['Bindings'],
  sessionId: string,
  userId: string,
): Promise<{ ok: true; session: AgentSessionRow } | { ok: false; status: 403 | 404 }> {
  const db = getDb(env)
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1)
  const row = rows[0]

  if (!row) {
    return { ok: false, status: 404 }
  }

  // Ownership check: reject sessions that belong to a different real user.
  // "system" is a placeholder used by the 5-min discovery alarm (which has no
  // user context) — treat those as shared since duraclaw is single-user per VPS.
  // Per B-API-1, real-user mismatches return 404 (not 403) to avoid existence
  // disclosure.
  if (row.userId && row.userId !== userId && row.userId !== 'system') {
    return { ok: false, status: 404 }
  }

  return { ok: true, session: row as AgentSessionRow }
}

// ── GH#16 P3 Unit 1 — chain list + precondition helpers ────────────
//
// Module-level caches for GitHub issue/PR lists. Keyed by repo (we only
// ever target `env.GITHUB_REPO`, but keying by repo keeps the cache correct
// if the env changes between requests — e.g. a test worker). TTL 5 minutes
// per spec "Resolved Questions". Cache is process-local; every Worker isolate
// keeps its own copy, which is fine for a 5min TTL and low QPS.

interface GhIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  updated_at?: string
  labels?: Array<{ name: string }>
  pull_request?: unknown // when present, the issue is actually a PR
}

interface GhPull {
  number: number
  head?: { ref?: string }
  body?: string | null
}

interface GhIssueCacheEntry {
  issues: GhIssue[]
  moreAvailable: boolean
  expiresAt: number
}

interface GhPullCacheEntry {
  pulls: GhPull[]
  expiresAt: number
}

const GH_CACHE_TTL_MS = 5 * 60 * 1000
const ghIssueCache = new Map<string, GhIssueCacheEntry>()
const ghPullCache = new Map<string, GhPullCacheEntry>()

function ghHeaders(env: ApiAppEnv['Bindings']): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'duraclaw',
  }
  if (env.GITHUB_API_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_API_TOKEN}`
  }
  return headers
}

/**
 * Fetch up to 300 issues (3 pages × 100) from the configured GH repo.
 * Response includes a `moreAvailable` flag set when page 3 came back full
 * (indicating the caller truncated the feed). PR entries are filtered out
 * at merge time — the issues endpoint returns both but GH tags PRs with a
 * `pull_request` sub-object.
 */
async function fetchGithubIssues(
  env: ApiAppEnv['Bindings'],
): Promise<{ issues: GhIssue[]; moreAvailable: boolean }> {
  const repo = env.GITHUB_REPO
  if (!repo) return { issues: [], moreAvailable: false }

  const cached = ghIssueCache.get(repo)
  if (cached && cached.expiresAt > Date.now()) {
    return { issues: cached.issues, moreAvailable: cached.moreAvailable }
  }

  const all: GhIssue[] = []
  let moreAvailable = false
  for (let page = 1; page <= 3; page++) {
    const url = `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`
    const resp = await fetch(url, { headers: ghHeaders(env) })
    if (!resp.ok) {
      // Degrade gracefully — return whatever we have; do not populate cache
      // on error so the next call retries.
      return { issues: all, moreAvailable: false }
    }
    const batch = (await resp.json()) as GhIssue[]
    all.push(...batch)
    if (batch.length < 100) {
      break
    }
    if (page === 3 && batch.length === 100) {
      moreAvailable = true
    }
  }

  ghIssueCache.set(repo, {
    issues: all,
    moreAvailable,
    expiresAt: Date.now() + GH_CACHE_TTL_MS,
  })
  return { issues: all, moreAvailable }
}

/** Fetch up to 300 PRs from the configured GH repo, same cache strategy as issues. */
async function fetchGithubPulls(env: ApiAppEnv['Bindings']): Promise<GhPull[]> {
  const repo = env.GITHUB_REPO
  if (!repo) return []

  const cached = ghPullCache.get(repo)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.pulls
  }

  const all: GhPull[] = []
  for (let page = 1; page <= 3; page++) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100&page=${page}`
    const resp = await fetch(url, { headers: ghHeaders(env) })
    if (!resp.ok) {
      return all
    }
    const batch = (await resp.json()) as GhPull[]
    all.push(...batch)
    if (batch.length < 100) break
  }

  ghPullCache.set(repo, { pulls: all, expiresAt: Date.now() + GH_CACHE_TTL_MS })
  return all
}

function deriveIssueType(
  labels: Array<{ name: string }> | undefined,
): 'bug' | 'enhancement' | 'other' {
  const names = new Set((labels ?? []).map((l) => l.name))
  // Precedence per spec B7: bug > enhancement > other
  if (names.has('bug')) return 'bug'
  if (names.has('enhancement')) return 'enhancement'
  return 'other'
}

const COLUMN_QUALIFYING_MODES = new Set([
  'research',
  'planning',
  'implementation',
  'task',
  'verify',
])

function modeToColumn(mode: string): ChainSummary['column'] | null {
  switch (mode) {
    case 'research':
      return 'research'
    case 'planning':
      return 'planning'
    case 'implementation':
    case 'task':
      return 'implementation'
    case 'verify':
      return 'verify'
    default:
      return null
  }
}

/**
 * Pick the current kanban column for a chain. Rules (spec B7):
 *   1. Issue closed → `done`
 *   2. No sessions → `backlog`
 *   3. Latest session whose kataMode is in the qualifying set (research,
 *      planning, implementation, task, verify) — skip debug/freeform side
 *      quests. Use the session's lastActivity (fall back to createdAt) for
 *      "latest".
 *   4. Fallback `backlog`.
 */
function deriveColumn(
  sessions: Array<{ kataMode: string | null; lastActivity: string | null; createdAt: string }>,
  issueState: 'open' | 'closed',
): ChainSummary['column'] {
  if (issueState === 'closed') return 'done'
  if (!sessions.length) return 'backlog'

  let bestMode: string | null = null
  let bestTs = -Infinity
  for (const s of sessions) {
    if (!s.kataMode || !COLUMN_QUALIFYING_MODES.has(s.kataMode)) continue
    const ts = new Date(s.lastActivity ?? s.createdAt).getTime()
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts
      bestMode = s.kataMode
    }
  }

  if (bestMode) {
    const col = modeToColumn(bestMode)
    if (col) return col
  }
  return 'backlog'
}

/**
 * Find a matching PR for an issue. Two detection strategies (first match
 * wins per PR; we scan all PRs and return the first that binds):
 *   1. Branch pattern `^(feature|fix|feat)/(\d+)[-_]` on `pull_request.head.ref`
 *   2. Body contains `Closes #N` or `Fixes #N` (case-insensitive)
 */
function findPrForIssue(pulls: GhPull[], issueNumber: number): number | undefined {
  for (const pr of pulls) {
    const branch = pr.head?.ref ?? ''
    const branchMatch = branch.match(/^(?:feature|fix|feat)\/(\d+)[-_]/)
    if (branchMatch && Number.parseInt(branchMatch[1], 10) === issueNumber) {
      return pr.number
    }
    const body = pr.body ?? ''
    // `m` flag so multi-line bodies are scanned per line; `i` for case insensitivity.
    const bodyRe = new RegExp(`(?:closes|fixes)\\s+#${issueNumber}(?![0-9])`, 'i')
    if (bodyRe.test(body)) {
      return pr.number
    }
  }
  return undefined
}

/**
 * Tiny YAML frontmatter parser — handles `---\n<lines>\n---\n` blocks with
 * `key: value` lines. Values are trimmed and stripped of matching outer
 * quotes. Good enough for spec/VP metadata where we only read `status`-style
 * scalars; does not support nested maps or arrays.
 */
function parseFrontmatter(markdown: string): Record<string, string> {
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
 * Read a file from the gateway's project-browse endpoint. Returns null on
 * any gateway error (matches spec "graceful degrade" for spec/VP status).
 */
async function fetchGatewayFile(
  env: ApiAppEnv['Bindings'],
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

interface GatewayFileEntry {
  name: string
  path?: string
  type?: string
  modified?: string | number
}

/** List files under a project-relative directory via the gateway. */
async function listGatewayFiles(
  env: ApiAppEnv['Bindings'],
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

export function createApiApp() {
  const app = new Hono<ApiAppEnv>()

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.route('/api/auth', authRoutes)

  app.get('/api/push/vapid-key', (c) => {
    const publicKey = c.env.VAPID_PUBLIC_KEY
    if (!publicKey) {
      return c.json({ error: 'Push not configured' }, 503)
    }
    return c.json({ publicKey })
  })

  // Tool approval — supports both session cookie auth AND Bearer action token auth
  // Must be BEFORE authMiddleware because Bearer tokens bypass session auth
  app.post('/api/sessions/:id/tool-approval', async (c) => {
    const sessionId = c.req.param('id')
    const body = (await c.req.json()) as { approved?: boolean; toolCallId?: string }

    if (typeof body.approved !== 'boolean') {
      return c.json({ error: 'Invalid tool approval payload' }, 400)
    }

    // Check for Bearer token auth first (from push notification actions)
    const authHeader = c.req.header('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const result = await validateActionToken(token, c.env.BETTER_AUTH_SECRET)
      if (!result.ok) {
        return c.json({ error: result.error }, 401)
      }

      // Token is valid — use sid/gid from token
      if (result.sid !== sessionId) {
        return c.json({ error: 'Token session mismatch' }, 401)
      }

      const doId = getSessionDoId(c.env, sessionId)
      const sessionDO = c.env.SESSION_AGENT.get(doId)
      const response = await sessionDO.fetch(
        new Request('https://session/tool-approval', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-partykit-room': sessionId,
            'x-user-id': 'action-token',
          },
          body: JSON.stringify({
            approved: body.approved,
            toolCallId: result.gid,
          }),
        }),
      )

      if (!response.ok) {
        return c.json({ error: 'Tool approval failed' }, 400)
      }

      return c.json({ ok: true })
    }

    // Fall back to session cookie auth
    const session = await getRequestSession(c.env, c.req.raw)
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const userId = session.userId

    const ownership = await getOwnedSession(c.env, sessionId, userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    if (typeof body.toolCallId !== 'string') {
      return c.json({ error: 'Invalid tool approval payload' }, 400)
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/tool-approval', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
        body: JSON.stringify({
          approved: body.approved,
          toolCallId: body.toolCallId,
        }),
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Tool approval failed' }, 400)
    }

    return c.json({ ok: true })
  })

  // Token-protected bootstrap endpoint — creates the first admin user.
  // Requires BOOTSTRAP_TOKEN secret. Remove the secret after use to lock down.
  app.post('/api/bootstrap', async (c) => {
    const token = c.env.BOOTSTRAP_TOKEN
    if (!token) {
      return c.json({ error: 'Bootstrap is disabled' }, 403)
    }

    const authHeader = c.req.header('authorization')
    if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== token) {
      return c.json({ error: 'Invalid bootstrap token' }, 401)
    }

    const body = (await c.req.json()) as {
      email?: string
      password?: string
      name?: string
    }
    if (!body.email || !body.password || !body.name) {
      return c.json({ error: 'Missing required fields: email, password, name' }, 400)
    }

    const auth = createAuth(c.env, { allowSignUp: true }) as any
    const result = await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
    })

    if (!result?.user?.id) {
      return c.json({ error: 'Failed to create user' }, 500)
    }

    // Promote to admin
    await c.env.AUTH_DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
      .bind(result.user.id)
      .run()

    return c.json({ ok: true, userId: result.user.id, role: 'admin' })
  })

  // GitHub webhook — MUST bypass authMiddleware (signature is the auth).
  // Registered before `app.use('/api/*', authMiddleware)` so the middleware
  // doesn't see unauthenticated webhook traffic. Signature verification uses
  // Web Crypto (Workers runtime — no node:crypto `timingSafeEqual`).
  app.post('/api/webhooks/github', async (c) => {
    if (!c.env.GITHUB_WEBHOOK_SECRET) {
      return c.json({ error: 'Webhook not configured' }, 503)
    }

    const rawBody = await c.req.text()
    const sig = c.req.header('x-hub-signature-256')
    const valid = await verifyGithubSignature(c.env.GITHUB_WEBHOOK_SECRET, sig, rawBody)
    if (!valid) {
      return c.json({ error: 'Invalid signature' }, 401)
    }

    let payload: {
      repository?: { full_name?: string }
      action?: string
      issue?: { number?: number }
      pull_request?: {
        number?: number
        merged?: boolean
        head?: { ref?: string }
        body?: string | null
      }
    }
    try {
      payload = JSON.parse(rawBody)
    } catch {
      // Malformed JSON post-signature is still an ack — we verified the body
      // belongs to GitHub. Return 200 with an ignored marker.
      return c.json({ ignored: 'invalid json' })
    }

    if (payload.repository?.full_name !== c.env.GITHUB_REPO) {
      return c.json({ ignored: 'wrong repo' })
    }

    const event = c.req.header('x-github-event')
    let issueNumber: number | undefined

    if (event === 'issues' && payload.action === 'closed') {
      issueNumber = payload.issue?.number
    } else if (
      event === 'pull_request' &&
      payload.action === 'closed' &&
      payload.pull_request?.merged === true
    ) {
      const branchRef = payload.pull_request.head?.ref ?? ''
      const branchMatch = branchRef.match(/^(?:feature|fix|feat)\/(\d+)[-_]/)
      if (branchMatch) {
        issueNumber = Number.parseInt(branchMatch[1], 10)
      } else {
        const body = payload.pull_request.body ?? ''
        const bodyMatch = body.match(/(?:closes|fixes)\s+#(\d+)/i)
        if (bodyMatch) {
          issueNumber = Number.parseInt(bodyMatch[1], 10)
        }
      }

      if (issueNumber === undefined || !Number.isFinite(issueNumber)) {
        console.log('[gh-webhook] PR merged without linkable issue:', payload.pull_request.number)
        return c.json({ ignored: 'no linkable issue' })
      }
    } else {
      return c.json({ ignored: true })
    }

    if (issueNumber === undefined || !Number.isFinite(issueNumber)) {
      return c.json({ ignored: true })
    }

    const db = getDb(c.env)
    const deleted = await db
      .delete(worktreeReservations)
      .where(eq(worktreeReservations.issueNumber, issueNumber))
      .returning({ worktree: worktreeReservations.worktree })

    return c.json({ released: true, issueNumber, deleted: deleted.length })
  })

  app.use('/api/*', authMiddleware)

  // ── User settings (tabs) — direct D1 CRUD (B-API-2) ──────────────

  app.get('/api/user-settings/tabs', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)
    const tabs = await db
      .select()
      .from(userTabs)
      .where(eq(userTabs.userId, userId))
      .orderBy(asc(userTabs.position))
    return c.json({ tabs: tabs as UserTabRow[] })
  })

  app.post('/api/user-settings/tabs', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => null)) as {
      id?: string
      sessionId?: string | null
      position?: number
    } | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid body' }, 400)
    }

    const db = getDb(c.env)
    let position = body.position
    if (typeof position !== 'number') {
      const maxRow = await db
        .select({ max: sql<number | null>`MAX(${userTabs.position})` })
        .from(userTabs)
        .where(eq(userTabs.userId, userId))
      const max = maxRow[0]?.max
      position = typeof max === 'number' ? max + 1 : 0
    }

    // Dedup: if a tab already exists for this (userId, sessionId), return it
    const sessionId = body.sessionId ?? null
    if (sessionId) {
      const existing = await db
        .select()
        .from(userTabs)
        .where(and(eq(userTabs.userId, userId), eq(userTabs.sessionId, sessionId)))
        .limit(1)
      if (existing.length > 0) {
        return c.json({ tab: existing[0] as UserTabRow }, 200)
      }
    }

    const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const inserted = await db
      .insert(userTabs)
      .values({
        id,
        userId,
        sessionId,
        position,
        createdAt,
      })
      .returning()

    await notifyInvalidation(c.env, userId, 'user_tabs')
    return c.json({ tab: inserted[0] as UserTabRow }, 201)
  })

  app.patch('/api/user-settings/tabs/:id', async (c) => {
    const userId = c.get('userId')
    const tabId = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid body' }, 400)
    }

    for (const key of Object.keys(body)) {
      if (!TAB_PATCH_KEYS.has(key)) {
        return c.json({ error: `Unknown field: ${key}` }, 400)
      }
    }

    const db = getDb(c.env)
    const updated = await db
      .update(userTabs)
      .set(body as Partial<typeof userTabs.$inferInsert>)
      .where(and(eq(userTabs.id, tabId), eq(userTabs.userId, userId)))
      .returning()

    if (updated.length === 0) {
      return c.json({ error: 'Tab not found' }, 404)
    }

    await notifyInvalidation(c.env, userId, 'user_tabs')
    return c.json({ tab: updated[0] as UserTabRow })
  })

  app.delete('/api/user-settings/tabs/:id', async (c) => {
    const userId = c.get('userId')
    const tabId = c.req.param('id')
    const db = getDb(c.env)
    const deleted = await db
      .delete(userTabs)
      .where(and(eq(userTabs.id, tabId), eq(userTabs.userId, userId)))
      .returning({ id: userTabs.id })

    if (deleted.length === 0) {
      return c.json({ error: 'Tab not found' }, 404)
    }

    await notifyInvalidation(c.env, userId, 'user_tabs')
    return c.body(null, 204)
  })

  app.post('/api/user-settings/tabs/reorder', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => null)) as {
      orderedIds?: unknown
    } | null
    if (!body || !Array.isArray(body.orderedIds)) {
      return c.json({ error: 'Invalid body: orderedIds must be a string[]' }, 400)
    }
    const orderedIds = body.orderedIds
    if (!orderedIds.every((id) => typeof id === 'string')) {
      return c.json({ error: 'Invalid body: orderedIds must be a string[]' }, 400)
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      return c.json({ error: 'Duplicate ids in orderedIds' }, 400)
    }

    const ids = orderedIds as string[]
    const db = getDb(c.env)

    const result = await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: userTabs.id })
        .from(userTabs)
        .where(and(eq(userTabs.userId, userId), inArray(userTabs.id, ids)))
      if (owned.length !== ids.length) {
        return { ok: false as const }
      }
      for (let idx = 0; idx < ids.length; idx++) {
        await tx
          .update(userTabs)
          .set({ position: idx })
          .where(and(eq(userTabs.id, ids[idx]), eq(userTabs.userId, userId)))
      }
      return { ok: true as const }
    })

    if (!result.ok) {
      return c.json({ error: 'One or more ids not owned by caller' }, 400)
    }

    await notifyInvalidation(c.env, userId, 'user_tabs')
    return c.json({ ok: true })
  })

  // ── User preferences (columnar) — B-API-3 ────────────────────────

  app.get('/api/preferences', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1)
    if (rows[0]) {
      return c.json(rows[0] as UserPreferencesRow)
    }
    // Synthesise defaults without inserting — first-run users get a stable
    // envelope so the client UI doesn't have to handle a 404 case.
    const defaults: UserPreferencesRow = {
      userId,
      permissionMode: 'default',
      model: 'claude-opus-4-6',
      maxBudget: null,
      thinkingMode: 'adaptive',
      effort: 'high',
      hiddenProjects: null,
      updatedAt: new Date().toISOString(),
    }
    return c.json(defaults)
  })

  app.put('/api/preferences', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid body' }, 400)
    }

    for (const key of Object.keys(body)) {
      if (!PREF_PATCH_KEYS.has(key)) {
        return c.json({ error: `Unknown field: ${key}` }, 400)
      }
    }

    if (typeof body.permissionMode === 'string' && !PERMISSION_MODES.has(body.permissionMode)) {
      return c.json({ error: `Invalid permissionMode: ${body.permissionMode}` }, 400)
    }
    if (typeof body.thinkingMode === 'string' && !THINKING_MODES.has(body.thinkingMode)) {
      return c.json({ error: `Invalid thinkingMode: ${body.thinkingMode}` }, 400)
    }
    if (typeof body.effort === 'string' && !EFFORTS.has(body.effort)) {
      return c.json({ error: `Invalid effort: ${body.effort}` }, 400)
    }
    if (
      body.maxBudget !== undefined &&
      body.maxBudget !== null &&
      typeof body.maxBudget !== 'number'
    ) {
      return c.json({ error: 'maxBudget must be a number or null' }, 400)
    }
    if (body.hiddenProjects !== undefined && body.hiddenProjects !== null) {
      if (typeof body.hiddenProjects !== 'string') {
        return c.json({ error: 'hiddenProjects must be a JSON string or null' }, 400)
      }
    }

    const updatedAt = new Date().toISOString()
    const db = getDb(c.env)
    const setValues = { ...(body as Partial<typeof userPreferences.$inferInsert>), updatedAt }
    const inserted = await db
      .insert(userPreferences)
      .values({ userId, ...setValues })
      .onConflictDoUpdate({ target: userPreferences.userId, set: setValues })
      .returning()

    await notifyInvalidation(c.env, userId, 'user_preferences')
    return c.json({ preferences: inserted[0] as UserPreferencesRow })
  })

  app.post('/api/push/subscribe', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as {
      endpoint?: string
      keys?: { p256dh?: string; auth?: string }
    }

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return c.json({ error: 'Missing required fields: endpoint, keys.p256dh, keys.auth' }, 400)
    }

    try {
      new URL(body.endpoint)
    } catch {
      return c.json({ error: 'Invalid endpoint URL' }, 400)
    }

    const id = crypto.randomUUID()
    const userAgent = c.req.header('user-agent') ?? null

    await c.env.AUTH_DB.prepare(
      `INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES (
         COALESCE((SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?), ?),
         ?, ?, ?, ?, ?
       )`,
    )
      .bind(
        userId,
        body.endpoint,
        id,
        userId,
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        userAgent,
      )
      .run()

    return c.json({ ok: true }, 201)
  })

  app.post('/api/push/unsubscribe', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as { endpoint?: string }

    if (!body.endpoint) {
      return c.json({ error: 'Missing required field: endpoint' }, 400)
    }

    await c.env.AUTH_DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .bind(userId, body.endpoint)
      .run()

    return c.body(null, 204)
  })

  // ── FCM (Capacitor Android) push subscriptions ───────────────────
  // Native Android shell registers its FCM token here. Web push (VAPID)
  // continues to use /api/push/{subscribe,unsubscribe}. The fan-out side
  // (apps/orchestrator/src/agents/session-do.ts) reads both tables and
  // dispatches per platform.

  app.post('/api/push/fcm-subscribe', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as { token?: string; platform?: string }

    if (!body.token) {
      return c.json({ error: 'Missing required field: token' }, 400)
    }

    const platform = body.platform ?? 'android'
    const id = crypto.randomUUID()

    // INSERT OR REPLACE on the unique token index — reassigns ownership
    // when the same token has rotated to a different user (token rotation
    // / device hand-off). Keeps the existing id when same user re-registers.
    await c.env.AUTH_DB.prepare(
      `INSERT OR REPLACE INTO fcm_subscriptions (id, user_id, token, platform)
       VALUES (
         COALESCE((SELECT id FROM fcm_subscriptions WHERE token = ? AND user_id = ?), ?),
         ?, ?, ?
       )`,
    )
      .bind(body.token, userId, id, userId, body.token, platform)
      .run()

    return c.json({ ok: true }, 201)
  })

  app.post('/api/push/fcm-unsubscribe', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as { token?: string }

    if (!body.token) {
      return c.json({ error: 'Missing required field: token' }, 400)
    }

    await c.env.AUTH_DB.prepare('DELETE FROM fcm_subscriptions WHERE user_id = ? AND token = ?')
      .bind(userId, body.token)
      .run()

    return c.body(null, 204)
  })

  /**
   * Debug endpoint — send a test push notification to all of the caller's
   * subscribed devices with an arbitrary session URL.
   *
   * Auth: authenticated user only (hits their own subscriptions).
   *
   * Body (all fields optional):
   *   sessionId: string     — produces url="/?session=${sessionId}" if url omitted
   *   url:       string     — target URL for the notification tap (overrides sessionId)
   *   title:     string     — notification title (default "Duraclaw debug")
   *   body:      string     — notification body (default includes target url)
   *   tag:       string     — collapse tag (default "debug-push")
   *   actions:   [{action, title}]  — notification action buttons (default [{open}])
   *
   * Returns: {
   *   sent:      number of subscriptions we attempted
   *   results:   per-subscription { id, endpoint, ok, status, gone }
   *   payload:   the PushPayload that was sent
   * }
   *
   * Intended for diagnosing the notification-tap → navigation flow on
   * devices. Pair with `wrangler tail` to watch the [push:dispatch] and
   * [sw:*] log streams end-to-end.
   */
  app.post('/api/debug/push', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string
      url?: string
      title?: string
      body?: string
      tag?: string
      actions?: Array<{ action: string; title: string }>
    }

    const sessionId = body.sessionId ?? ''
    const url = body.url ?? (sessionId ? `/?session=${sessionId}` : '/')
    const title = body.title ?? 'Duraclaw debug'
    const payloadBody = body.body ?? `Debug push → ${url}`
    const tag = body.tag ?? 'debug-push'
    const actions = body.actions ?? [{ action: 'open', title: 'Open' }]

    const vapidPublicKey = c.env.VAPID_PUBLIC_KEY
    const vapidPrivateKey = c.env.VAPID_PRIVATE_KEY
    const vapidSubject = c.env.VAPID_SUBJECT
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      return c.json({ error: 'VAPID not configured on this deployment' }, 500)
    }

    const subsResult = await c.env.AUTH_DB.prepare(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    )
      .bind(userId)
      .all<{ id: string; endpoint: string; p256dh: string; auth: string }>()

    const subscriptions = subsResult.results
    if (subscriptions.length === 0) {
      return c.json(
        { error: 'No push subscriptions for this user — subscribe in Settings first' },
        404,
      )
    }

    const payload: PushPayload = {
      title,
      body: payloadBody,
      url,
      tag,
      sessionId,
      actions,
    }
    const vapid = { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject }

    const results: Array<{
      id: string
      endpoint: string
      ok: boolean
      status?: number
      gone?: boolean
    }> = []

    for (const sub of subscriptions) {
      const result = await sendPushNotification(sub, payload, vapid)
      results.push({
        id: sub.id,
        endpoint: `${sub.endpoint.slice(0, 60)}...`,
        ok: result.ok,
        status: result.status,
        gone: result.gone,
      })
      // Prune gone subscriptions so the debug endpoint self-heals stale entries.
      if (result.gone) {
        await c.env.AUTH_DB.prepare('DELETE FROM push_subscriptions WHERE id = ?')
          .bind(sub.id)
          .run()
      }
    }

    console.log(
      `[debug:push] userId=${userId} sent=${subscriptions.length} url=${url} results=${JSON.stringify(results)}`,
    )

    return c.json({ sent: subscriptions.length, results, payload })
  })

  app.get('/api/projects', async (c) => {
    const userId = c.get('userId')

    try {
      const projects = await fetchGatewayProjects(c.env)
      const hiddenSet = await getHiddenProjects(c.env, userId)
      const visibleProjects =
        hiddenSet.size > 0 ? projects.filter((p) => !hiddenSet.has(p.name)) : projects

      const db = getDb(c.env)
      const merged = await Promise.all(
        visibleProjects.map(async (project) => {
          const sessions = await db
            .select()
            .from(agentSessions)
            .where(and(eq(agentSessions.userId, userId), eq(agentSessions.project, project.name)))
            .orderBy(desc(agentSessions.lastActivity))
          return { ...project, sessions: sessions as AgentSessionRow[] }
        }),
      )

      return c.json({ projects: merged })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway unreachable'
      return c.json({ error: message }, 502)
    }
  })

  app.get('/api/sessions', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId))
      .orderBy(desc(agentSessions.lastActivity))
      .limit(200)
    return c.json({ sessions: rows as AgentSessionRow[] })
  })

  app.get('/api/sessions/active', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(agentSessions)
      .where(
        and(eq(agentSessions.userId, userId), inArray(agentSessions.status, [...ACTIVE_STATUSES])),
      )
      .orderBy(desc(agentSessions.lastActivity))
    return c.json({ sessions: rows as AgentSessionRow[] })
  })

  app.get('/api/sessions/search', async (c) => {
    const q = c.req.query('q')
    if (!q) return c.json({ sessions: [] })
    const userId = c.get('userId')
    const needle = `%${q}%`
    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.userId, userId),
          or(
            like(agentSessions.prompt, needle),
            like(agentSessions.project, needle),
            like(agentSessions.id, needle),
            like(agentSessions.title, needle),
            like(agentSessions.summary, needle),
            like(agentSessions.agent, needle),
            like(agentSessions.sdkSessionId, needle),
          ),
        ),
      )
      .orderBy(desc(agentSessions.lastActivity))
      .limit(200)
    return c.json({ sessions: rows as AgentSessionRow[] })
  })

  app.get('/api/sessions/history', async (c) => {
    const userId = c.get('userId')
    const sortByParam = c.req.query('sortBy')
    const sortDirParam = c.req.query('sortDir')
    const status = c.req.query('status')
    const project = c.req.query('project')
    const model = c.req.query('model')
    const limitParam = c.req.query('limit')
    const offsetParam = c.req.query('offset')

    const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200)
    const offset = Math.max(Number(offsetParam) || 0, 0)

    const sortColumn = (() => {
      switch (sortByParam) {
        case 'created_at':
          return agentSessions.createdAt
        case 'updated_at':
          return agentSessions.updatedAt
        case 'project':
          return agentSessions.project
        case 'status':
          return agentSessions.status
        default:
          return agentSessions.lastActivity
      }
    })()
    const orderExpr = sortDirParam === 'asc' ? asc(sortColumn) : desc(sortColumn)

    const filters = [eq(agentSessions.userId, userId)]
    if (status) filters.push(eq(agentSessions.status, status))
    if (project) filters.push(eq(agentSessions.project, project))
    if (model) filters.push(eq(agentSessions.model, model))

    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(agentSessions)
      .where(and(...filters))
      .orderBy(orderExpr)
      .limit(limit)
      .offset(offset)

    return c.json({
      sessions: rows as AgentSessionRow[],
      nextOffset: rows.length === limit ? offset + limit : null,
    })
  })

  app.post('/api/sessions/sync', async (c) => {
    const userId = c.get('userId')

    if (!c.env.CC_GATEWAY_URL) {
      return c.json({ error: 'CC_GATEWAY_URL not configured' }, 500)
    }

    const httpBase = c.env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const sessionsUrl = new URL('/sessions', httpBase)
    const headers: Record<string, string> = {}
    if (c.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${c.env.CC_GATEWAY_SECRET}`
    }

    interface GatewaySnapshot {
      session_id: string
      state: string
      sdk_session_id: string | null
      last_activity_ts: number | null
      cost: { input_tokens: number; output_tokens: number; usd: number }
      model: string | null
      turn_count: number
    }

    let snapshots: GatewaySnapshot[]
    try {
      const resp = await fetch(sessionsUrl.toString(), { headers })
      if (!resp.ok) {
        return c.json({ error: `Gateway returned ${resp.status}` }, 502)
      }
      const data = (await resp.json()) as { ok?: boolean; sessions?: GatewaySnapshot[] }
      snapshots = data.sessions ?? []
    } catch {
      return c.json({ error: 'Gateway unreachable' }, 502)
    }

    const db = getDb(c.env)
    const now = new Date().toISOString()
    let updated = 0
    let skipped = 0

    // Update existing D1 rows with fresh gateway data (cost, status, model).
    // Does not insert — the gateway's thin response lacks project/prompt info.
    await db.transaction(async (tx) => {
      for (const s of snapshots) {
        if (!s.sdk_session_id) {
          skipped++
          continue
        }

        const lastActivity = s.last_activity_ts ? new Date(s.last_activity_ts).toISOString() : now

        const status = s.state === 'running' ? 'running' : 'idle'

        try {
          await tx
            .update(agentSessions)
            .set({
              status,
              model: s.model ?? undefined,
              updatedAt: now,
              lastActivity: lastActivity,
              numTurns: s.turn_count || undefined,
              totalCostUsd: s.cost.usd || undefined,
            })
            .where(eq(agentSessions.sdkSessionId, s.sdk_session_id))
          updated++
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.warn(`[sync] update failed for ${s.sdk_session_id}: ${message}`)
        }
      }
    })

    await notifyInvalidation(c.env, userId, 'agent_sessions')
    return c.json({ updated, skipped, total: snapshots.length })
  })

  app.post('/api/sessions', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as CreateSessionBody

    if (!body.project || !body.prompt) {
      return c.json({ error: 'Missing required fields: project, prompt' }, 400)
    }

    // Validate kataIssue — must be a positive integer if supplied. This
    // protects downstream consumers (chain joins, worktree reservations)
    // from negative / fractional / NaN issue numbers.
    if (body.kataIssue !== undefined && body.kataIssue !== null) {
      if (!Number.isInteger(body.kataIssue) || body.kataIssue <= 0) {
        return c.json({ error: 'invalid_kata_issue' }, 400)
      }
    }

    const projectPath = await resolveProjectPath(c.env, body.project)

    const doId = c.env.SESSION_AGENT.newUniqueId()
    const sessionId = doId.toString()
    const sessionDO = c.env.SESSION_AGENT.get(doId)

    const createResponse = await sessionDO.fetch(
      new Request('https://session/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': sessionId,
          'x-user-id': userId,
        },
        body: JSON.stringify({
          project: body.project,
          project_path: projectPath,
          prompt: body.prompt,
          model: body.model,
          system_prompt: body.system_prompt,
          sdk_session_id: body.sdk_session_id,
          agent: body.agent,
          userId,
        }),
      }),
    )

    if (!createResponse.ok) {
      return c.json({ error: 'Failed to create session' }, 500)
    }

    const now = new Date().toISOString()
    const promptText = typeof body.prompt === 'string' ? body.prompt : JSON.stringify(body.prompt)
    const db = getDb(c.env)

    const baseRow = {
      id: sessionId,
      userId,
      project: body.project,
      status: 'running',
      model: body.model ?? null,
      sdkSessionId: body.sdk_session_id ?? null,
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      numTurns: null as number | null,
      prompt: promptText,
      summary: null as string | null,
      title: null as string | null,
      tag: null as string | null,
      origin: 'duraclaw',
      agent: body.agent ?? 'claude',
      archived: false,
      durationMs: null as number | null,
      totalCostUsd: null as number | null,
      messageCount: null as number | null,
      kataMode: null as string | null,
      kataIssue: typeof body.kataIssue === 'number' ? body.kataIssue : (null as number | null),
      kataPhase: null as string | null,
    }

    if (body.sdk_session_id) {
      // Resume path — UPSERT on sdk_session_id swaps in the new DO id
      // (matches the previous registry.replaceSessionForResume semantics).
      await db
        .insert(agentSessions)
        .values(baseRow)
        .onConflictDoUpdate({
          target: agentSessions.sdkSessionId,
          set: {
            id: sessionId,
            userId,
            project: body.project,
            status: 'running',
            model: baseRow.model,
            updatedAt: now,
            lastActivity: now,
            agent: baseRow.agent,
          },
        })
    } else {
      await db.insert(agentSessions).values(baseRow)
    }

    await notifyInvalidation(c.env, userId, 'agent_sessions')
    return c.json({ session_id: sessionId }, 201)
  })

  app.get('/api/sessions/:id', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    // Merge: D1 metadata + DO runtime state. The DO owns live fields like
    // pending gates, current turn message id, etc. that are not in agent_sessions.
    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/state', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }

    const doState = (await response.json()) as Record<string, unknown>
    return c.json({ session: { ...ownership.session, ...doState } })
  })

  app.get('/api/sessions/:id/messages', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/messages', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }

    // SessionDO /messages already returns `{messages: SessionMessage[]}`; pass
    // through verbatim. Previously we re-wrapped the whole body as `{messages}`,
    // producing `{messages: {messages: [...]}}` which broke the client
    // queryFn's `json.messages.map(...)` → empty collection → existing sessions
    // rendered blank on cold start / OPFS rehydrate (post GH#14).
    const body = (await response.json()) as { messages: unknown }
    return c.json({ messages: body.messages })
  })

  // P3 B4: REST endpoint for context usage. Scaffolding only — consumer
  // migration (swapping the client's WS `context_usage` handler to poll this)
  // is deferred to a separate issue per spec Non-Goals.
  app.get('/api/sessions/:id/context-usage', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }
    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/context-usage', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )
    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }
    const body = (await response.json()) as {
      contextUsage: ContextUsage | null
      fetchedAt: string
      isCached: boolean
    }
    return c.json(body)
  })

  // P3 B5: REST endpoint for kata state, backed by the D1 mirror. Survives
  // runner teardown — the D1 row persists even when the runner is dead.
  app.get('/api/sessions/:id/kata-state', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }
    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/kata-state', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )
    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }
    const body = (await response.json()) as {
      kataState: KataSessionState | null
      fetchedAt: string
    }
    return c.json(body)
  })

  app.patch('/api/sessions/:id', async (c) => {
    const userId = c.get('userId')
    const sessionId = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid body' }, 400)
    }

    for (const key of Object.keys(body)) {
      if (!SESSION_PATCH_KEYS.has(key)) {
        return c.json({ error: `Unknown field: ${key}` }, 400)
      }
    }

    const updatedAt = new Date().toISOString()
    const db = getDb(c.env)
    const updated = await db
      .update(agentSessions)
      .set({ ...(body as Partial<typeof agentSessions.$inferInsert>), updatedAt })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
      .returning()

    if (updated.length === 0) {
      // Either the session doesn't exist or it's owned by a different real
      // user — collapsed to 404 to avoid existence disclosure (B-API-1).
      return c.json({ error: 'Session not found' }, 404)
    }

    await notifyInvalidation(c.env, userId, 'agent_sessions')
    return c.json({ session: updated[0] as AgentSessionRow })
  })

  app.get('/api/gateway/projects', async (c) => {
    try {
      const projects = await fetchGatewayProjects(c.env)
      const userId = c.get('userId')
      const hiddenSet = await getHiddenProjects(c.env, userId)
      const filtered =
        hiddenSet.size > 0 ? projects.filter((p) => !hiddenSet.has(p.name)) : projects
      return c.json(filtered)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway unreachable'
      return c.json({ error: message }, 502)
    }
  })

  app.get('/api/gateway/projects/all', async (c) => {
    try {
      const projects = await fetchGatewayProjects(c.env)
      const userId = c.get('userId')
      const hiddenSet = await getHiddenProjects(c.env, userId)
      return c.json(projects.map((p) => ({ ...p, hidden: hiddenSet.has(p.name) })))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway unreachable'
      return c.json({ error: message }, 502)
    }
  })

  app.post('/api/sessions/:id/fork', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const body = (await c.req.json()) as { up_to_message_id?: string; title?: string }
    const projectName = ownership.session.project
    const httpBase = (c.env.CC_GATEWAY_URL ?? '')
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
    if (!httpBase) {
      return c.json({ error: 'Gateway not configured' }, 502)
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (c.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${c.env.CC_GATEWAY_SECRET}`
    }

    // Find the SDK session ID from the SessionDO state
    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const stateResp = await sessionDO.fetch(
      new Request('https://session/state', {
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )
    if (!stateResp.ok) {
      return c.json({ error: 'Could not read session state' }, 500)
    }
    const sessionState = (await stateResp.json()) as { sdk_session_id?: string }
    const sdkSessionId = sessionState.sdk_session_id
    if (!sdkSessionId) {
      return c.json({ error: 'Session has no SDK session ID — cannot fork' }, 400)
    }

    const gatewayUrl = new URL(
      `/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sdkSessionId)}/fork`,
      httpBase,
    )

    const response = await fetch(gatewayUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        up_to_message_id: body.up_to_message_id,
        title: body.title,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      return c.json({ error: `Fork failed: ${text}` }, response.status as any)
    }

    const result = (await response.json()) as { session_id: string }
    return c.json({ session_id: result.session_id })
  })

  app.post('/api/sessions/:id/abort', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/abort', {
        method: 'POST',
        headers: {
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Abort failed' }, response.status === 403 ? 403 : 400)
    }

    return c.json({ status: 'idle' })
  })

  // ── Chain worktree reservations (GH#16 Feature 3E / U2) ──────────
  //
  // Concurrency: D1's single-writer SQLite semantics + the `worktree`
  // PRIMARY KEY on worktree_reservations make checkout safe without an
  // explicit mutex. If a race slips through SELECT, INSERT throws a
  // UNIQUE constraint error which we catch and translate into a 409
  // with the winning reservation.

  const FORCE_RELEASE_STALE_DAYS = 7
  const FORCE_RELEASE_STALE_MS = FORCE_RELEASE_STALE_DAYS * 86_400_000

  function reservationToDto(r: typeof worktreeReservations.$inferSelect): WorktreeReservation {
    return {
      issueNumber: r.issueNumber,
      worktree: r.worktree,
      ownerId: r.ownerId,
      heldSince: r.heldSince,
      lastActivityAt: r.lastActivityAt,
      modeAtCheckout: r.modeAtCheckout,
      stale: !!r.stale,
    }
  }

  app.post('/api/chains/:issue/checkout', async (c) => {
    const userId = c.get('userId')
    const issueNumber = Number.parseInt(c.req.param('issue'), 10)
    if (!Number.isFinite(issueNumber)) {
      return c.json({ error: 'Invalid issue number' }, 400)
    }

    const body = (await c.req.json().catch(() => null)) as {
      worktree?: unknown
      modeAtCheckout?: unknown
    } | null
    if (!body || typeof body.worktree !== 'string' || body.worktree.length === 0) {
      return c.json({ error: 'Missing required field: worktree' }, 400)
    }
    const worktree = body.worktree
    const modeAtCheckout =
      typeof body.modeAtCheckout === 'string' && body.modeAtCheckout.length > 0
        ? body.modeAtCheckout
        : 'implementation'

    const db = getDb(c.env)
    const now = new Date().toISOString()

    const existingRows = await db
      .select()
      .from(worktreeReservations)
      .where(eq(worktreeReservations.worktree, worktree))
      .limit(1)
    const existing = existingRows[0]

    if (existing) {
      if (existing.issueNumber === issueNumber) {
        // Same-chain re-entry — idempotent refresh.
        const refreshed = await db
          .update(worktreeReservations)
          .set({ lastActivityAt: now, stale: false })
          .where(eq(worktreeReservations.worktree, worktree))
          .returning()
        const row = refreshed[0] ?? { ...existing, lastActivityAt: now, stale: false }
        return c.json({ reservation: reservationToDto(row) })
      }
      return c.json(
        {
          conflict: reservationToDto(existing),
          message: `Worktree held by chain #${existing.issueNumber}`,
        },
        409,
      )
    }

    try {
      const inserted = await db
        .insert(worktreeReservations)
        .values({
          worktree,
          issueNumber,
          ownerId: userId,
          heldSince: now,
          lastActivityAt: now,
          modeAtCheckout,
          stale: false,
        })
        .returning()
      return c.json({ reservation: reservationToDto(inserted[0]) })
    } catch (err) {
      // UNIQUE constraint race — re-read and return 409 with winner.
      const raceRows = await db
        .select()
        .from(worktreeReservations)
        .where(eq(worktreeReservations.worktree, worktree))
        .limit(1)
      const winner = raceRows[0]
      if (winner && winner.issueNumber === issueNumber) {
        // Unlikely but possible: peer request was for the same chain.
        return c.json({ reservation: reservationToDto(winner) })
      }
      if (winner) {
        return c.json(
          {
            conflict: reservationToDto(winner),
            message: `Worktree held by chain #${winner.issueNumber}`,
          },
          409,
        )
      }
      // Row disappeared between INSERT failure and re-read — surface the
      // original error rather than invent a state.
      const message = err instanceof Error ? err.message : 'Checkout failed'
      return c.json({ error: message }, 500)
    }
  })

  app.post('/api/chains/:issue/release', async (c) => {
    const userId = c.get('userId')
    const issueNumber = Number.parseInt(c.req.param('issue'), 10)
    if (!Number.isFinite(issueNumber)) {
      return c.json({ error: 'Invalid issue number' }, 400)
    }

    const db = getDb(c.env)
    const targets = await db
      .select()
      .from(worktreeReservations)
      .where(eq(worktreeReservations.issueNumber, issueNumber))
    if (targets.length === 0) {
      // Idempotent — no reservation means nothing to release.
      return c.json({ released: true, count: 0 })
    }

    // Ownership check — only the reservation owner may call /release.
    // Non-owners must use /force-release (which enforces the stale gate).
    const nonOwned = targets.filter((r) => r.ownerId !== userId)
    if (nonOwned.length > 0) {
      return c.json({ error: 'not_owner', reservation: nonOwned[0] }, 403)
    }

    await db.delete(worktreeReservations).where(eq(worktreeReservations.issueNumber, issueNumber))

    for (const r of targets) {
      await db.insert(auditLog).values({
        action: 'reservation_released',
        userId,
        details: JSON.stringify({ issueNumber, worktree: r.worktree }),
      })
    }

    return c.json({ released: true, count: targets.length })
  })

  app.post('/api/chains/:issue/force-release', async (c) => {
    const userId = c.get('userId')
    const issueNumber = Number.parseInt(c.req.param('issue'), 10)
    if (!Number.isFinite(issueNumber)) {
      return c.json({ error: 'Invalid issue number' }, 400)
    }

    const body = (await c.req.json().catch(() => null)) as {
      confirmation?: unknown
      worktree?: unknown
    } | null
    if (!body || body.confirmation !== true) {
      return c.json({ message: 'Missing confirmation' }, 400)
    }
    const worktreeFilter = typeof body.worktree === 'string' ? body.worktree : undefined

    const db = getDb(c.env)
    const targets = worktreeFilter
      ? await db
          .select()
          .from(worktreeReservations)
          .where(
            and(
              eq(worktreeReservations.issueNumber, issueNumber),
              eq(worktreeReservations.worktree, worktreeFilter),
            ),
          )
      : await db
          .select()
          .from(worktreeReservations)
          .where(eq(worktreeReservations.issueNumber, issueNumber))

    if (targets.length === 0) {
      return c.json({ message: 'No reservation for this chain' }, 404)
    }

    const staleCutoff = Date.now() - FORCE_RELEASE_STALE_MS
    for (const r of targets) {
      const lastActivityMs = new Date(r.lastActivityAt).getTime()
      const isStale = !!r.stale || (Number.isFinite(lastActivityMs) && lastActivityMs < staleCutoff)
      if (!isStale) {
        return c.json(
          {
            message: 'Reservation not stale enough',
            staleAfterDays: FORCE_RELEASE_STALE_DAYS,
            lastActivity: r.lastActivityAt,
          },
          403,
        )
      }
    }

    // All targets pass the gate — delete + audit.
    for (const r of targets) {
      await db.delete(worktreeReservations).where(eq(worktreeReservations.worktree, r.worktree))
      await db.insert(auditLog).values({
        action: 'force_release_worktree',
        userId,
        details: JSON.stringify({
          issueNumber,
          worktree: r.worktree,
          previousOwner: r.ownerId,
          heldSince: r.heldSince,
        }),
      })
    }

    return c.json({ released: true, forced: true, count: targets.length })
  })

  // ── Chain list + precondition endpoints (GH#16 P3 U1) ────────────

  app.get('/api/chains', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)

    // Parse + validate stale filter early so we can 400 before doing work.
    const staleParam = c.req.query('stale')
    let staleCutoff: number | null = null
    if (typeof staleParam === 'string' && staleParam.length > 0) {
      const m = staleParam.match(/^(\d+)d$/)
      if (!m) return c.json({ error: 'Invalid stale format — expected `{N}d`' }, 400)
      const days = Number.parseInt(m[1], 10)
      if (!Number.isFinite(days) || days <= 0) {
        return c.json({ error: 'Invalid stale format — expected `{N}d` with N > 0' }, 400)
      }
      staleCutoff = Date.now() - days * 86_400_000
    }

    const mineFilter = c.req.query('mine') !== undefined
    const laneFilter = c.req.query('lane')
    const columnFilter = c.req.query('column')
    const projectFilter = c.req.query('project')

    // 1. Collect issue numbers from D1.
    const d1IssueRows = await db
      .selectDistinct({ kataIssue: agentSessions.kataIssue })
      .from(agentSessions)
      .where(sql`${agentSessions.kataIssue} IS NOT NULL`)
    const d1IssueNumbers = new Set<number>()
    for (const row of d1IssueRows) {
      if (typeof row.kataIssue === 'number' && Number.isFinite(row.kataIssue)) {
        d1IssueNumbers.add(row.kataIssue)
      }
    }

    // 2. Fetch GH issues (cached).
    const { issues: ghIssues, moreAvailable } = await fetchGithubIssues(c.env)
    const ghIssueByNumber = new Map<number, GhIssue>()
    for (const issue of ghIssues) {
      // Filter out PRs — GH's /issues endpoint interleaves them.
      if (issue.pull_request) continue
      ghIssueByNumber.set(issue.number, issue)
    }

    // 3. Union of issue numbers.
    const allIssueNumbers = new Set<number>([...d1IssueNumbers, ...ghIssueByNumber.keys()])

    // Fetch PRs once for matching (also cached).
    const pulls = await fetchGithubPulls(c.env)

    // Pre-fetch all relevant sessions + reservations in two bulk queries to
    // avoid N×M SELECTs.
    const issueNumArray = Array.from(allIssueNumbers)
    const allSessions = issueNumArray.length
      ? ((await db
          .select()
          .from(agentSessions)
          .where(inArray(agentSessions.kataIssue, issueNumArray))
          .orderBy(asc(agentSessions.createdAt))) as AgentSessionRow[])
      : []
    const sessionsByIssue = new Map<number, AgentSessionRow[]>()
    for (const s of allSessions) {
      if (typeof s.kataIssue !== 'number') continue
      const list = sessionsByIssue.get(s.kataIssue) ?? []
      list.push(s)
      sessionsByIssue.set(s.kataIssue, list)
    }

    const allReservations = issueNumArray.length
      ? await db
          .select()
          .from(worktreeReservations)
          .where(inArray(worktreeReservations.issueNumber, issueNumArray))
      : []
    const reservationByIssue = new Map<number, (typeof allReservations)[number]>()
    for (const r of allReservations) {
      if (!reservationByIssue.has(r.issueNumber)) {
        reservationByIssue.set(r.issueNumber, r)
      }
    }

    // 4. Build ChainSummary[].
    const chains: ChainSummary[] = []
    for (const issueNumber of allIssueNumbers) {
      const ghIssue = ghIssueByNumber.get(issueNumber)
      const sessions = sessionsByIssue.get(issueNumber) ?? []

      let issueTitle: string
      let issueState: 'open' | 'closed'
      let issueType: string
      if (ghIssue) {
        issueTitle = ghIssue.title
        issueState = ghIssue.state
        issueType = deriveIssueType(ghIssue.labels)
      } else {
        // D1-only — issue off-page or deleted.
        issueTitle = `Issue #${issueNumber}`
        issueState = 'open'
        issueType = 'other'
      }

      const column = deriveColumn(
        sessions.map((s) => ({
          kataMode: s.kataMode,
          lastActivity: s.lastActivity,
          createdAt: s.createdAt,
        })),
        issueState,
      )

      const reservation = reservationByIssue.get(issueNumber)
      const worktreeReservation = reservation
        ? {
            worktree: reservation.worktree,
            heldSince: reservation.heldSince,
            lastActivityAt: reservation.lastActivityAt,
            ownerId: reservation.ownerId,
            stale: !!reservation.stale,
          }
        : null

      const prNumber = findPrForIssue(pulls, issueNumber)

      // lastActivity: max of (sessions' lastActivity || createdAt); fall back
      // to GH issue updated_at; empty string as a last resort.
      let lastActivity = ''
      let lastActivityTs = -Infinity
      for (const s of sessions) {
        const tsStr = s.lastActivity ?? s.createdAt
        const ts = new Date(tsStr).getTime()
        if (Number.isFinite(ts) && ts > lastActivityTs) {
          lastActivityTs = ts
          lastActivity = tsStr
        }
      }
      if (!lastActivity) {
        lastActivity = ghIssue?.updated_at ?? ''
      }

      const chain: ChainSummary = {
        issueNumber,
        issueTitle,
        issueType,
        issueState,
        column,
        sessions: sessions.map((s) => ({
          id: s.id,
          kataMode: s.kataMode,
          status: s.status,
          lastActivity: s.lastActivity,
          createdAt: s.createdAt,
          project: s.project,
        })),
        worktreeReservation,
        lastActivity,
        ...(prNumber !== undefined ? { prNumber } : {}),
      }

      // Preserve a reference to the underlying sessions for filter logic
      // below without exposing it in the response. We re-use the mapped
      // `sessions` array which already has `userId` stripped, so apply
      // owner-filter against the original rows.
      if (mineFilter) {
        const anyOwned = sessions.some((s) => s.userId === userId)
        if (!anyOwned) continue
      }
      if (laneFilter && chain.issueType !== laneFilter) continue
      if (columnFilter && chain.column !== columnFilter) continue
      if (projectFilter) {
        const hasProject = sessions.some((s) => s.project === projectFilter)
        if (!hasProject) continue
      }
      if (staleCutoff !== null) {
        const ts = new Date(chain.lastActivity).getTime()
        if (!Number.isFinite(ts) || ts >= staleCutoff) continue
      }

      chains.push(chain)
    }

    // Sort by lastActivity DESC (empty strings sink to the bottom).
    chains.sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : -Infinity
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : -Infinity
      return tb - ta
    })

    return c.json({ chains, more_issues_available: moreAvailable })
  })

  app.get('/api/chains/:issue/spec-status', async (c) => {
    const issueNumber = Number.parseInt(c.req.param('issue'), 10)
    if (!Number.isFinite(issueNumber)) {
      return c.json({ error: 'Invalid issue number' }, 400)
    }
    const project = c.req.query('project')
    if (!project) {
      return c.json({ error: 'Missing required query param: project' }, 400)
    }

    const entries = await listGatewayFiles(c.env, project, 'planning/specs')
    if (!entries) {
      return c.json<SpecStatusResponse>({ exists: false, status: null, path: null })
    }

    const pattern = new RegExp(`^${issueNumber}-.*\\.md$`)
    const matches = entries.filter((e) => pattern.test(e.name))
    if (matches.length === 0) {
      return c.json<SpecStatusResponse>({ exists: false, status: null, path: null })
    }

    // Pick latest by `modified` timestamp (numeric or ISO string both work).
    matches.sort((a, b) => {
      const ta = a.modified ? new Date(a.modified as string | number).getTime() : 0
      const tb = b.modified ? new Date(b.modified as string | number).getTime() : 0
      return tb - ta
    })
    const winner = matches[0]
    const relPath = winner.path ?? `planning/specs/${winner.name}`

    const content = await fetchGatewayFile(c.env, project, relPath)
    if (content === null) {
      return c.json<SpecStatusResponse>({ exists: false })
    }

    const fm = parseFrontmatter(content)
    const status = fm.status ?? null
    return c.json<SpecStatusResponse>({ exists: true, status, path: relPath })
  })

  app.get('/api/chains/:issue/vp-status', async (c) => {
    const issueNumber = Number.parseInt(c.req.param('issue'), 10)
    if (!Number.isFinite(issueNumber)) {
      return c.json({ error: 'Invalid issue number' }, 400)
    }
    const project = c.req.query('project')
    if (!project) {
      return c.json({ error: 'Missing required query param: project' }, 400)
    }

    const relPath = `.kata/verification-evidence/vp-${issueNumber}.json`
    const content = await fetchGatewayFile(c.env, project, relPath)
    if (content === null) {
      return c.json<VpStatusResponse>({ exists: false, passed: null, path: null })
    }

    try {
      const parsed = JSON.parse(content) as { overallPassed?: unknown }
      const passed = typeof parsed.overallPassed === 'boolean' ? parsed.overallPassed : null
      return c.json<VpStatusResponse>({ exists: true, passed, path: relPath })
    } catch {
      return c.json<VpStatusResponse>({ exists: false, passed: null, path: null })
    }
  })

  app.post('/api/sessions/:id/answers', async (c) => {
    const userId = c.get('userId')
    const ownership = await getOwnedSession(c.env, c.req.param('id'), userId)
    if (!ownership.ok) {
      return c.json(
        { error: ownership.status === 404 ? 'Session not found' : 'Forbidden' },
        ownership.status,
      )
    }

    const body = (await c.req.json()) as {
      answers?: Record<string, string>
      toolCallId?: string
    }
    if (!body.answers || typeof body.answers !== 'object') {
      return c.json({ error: 'Invalid answers payload' }, 400)
    }

    const doId = getSessionDoId(c.env, ownership.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': ownership.session.id,
          'x-user-id': userId,
        },
        body: JSON.stringify({
          answers: body.answers,
          ...(typeof body.toolCallId === 'string' ? { toolCallId: body.toolCallId } : {}),
        }),
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Submitting answers failed' }, 400)
    }

    return c.json({ ok: true })
  })

  return app
}
