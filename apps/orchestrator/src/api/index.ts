import type { SQL } from 'drizzle-orm'
import { and, asc, desc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { constantTimeEquals } from '~/agents/session-do/runner-link'
import * as schema from '~/db/schema'
import {
  agentSessions,
  auditLog,
  featureFlags,
  projectMetadata,
  projects as projectsTable,
  userPreferences,
  userPresence,
  users,
  userTabs,
  worktrees,
} from '~/db/schema'
import { validateActionToken } from '~/lib/action-token'
import { createAuth } from '~/lib/auth'
import { broadcastChainRow } from '~/lib/broadcast-chain'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import {
  fanoutSessionViewerChange,
  getSessionViewersForUser,
} from '~/lib/broadcast-session-viewers'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { broadcastTabsSnapshot } from '~/lib/broadcast-tabs-snapshot'
import { buildChainRowFromContext, type ChainBuildContext } from '~/lib/chains'
import { checkoutWorktree } from '~/lib/checkout-worktree'
import { chunkOps } from '~/lib/chunk-frame'
import { createSession } from '~/lib/create-session'
import {
  fetchGatewayFile as sharedFetchGatewayFile,
  fetchGatewayProjects as sharedFetchGatewayProjects,
  getSpecStatus as sharedGetSpecStatus,
  resolveProjectPath as sharedResolveProjectPath,
} from '~/lib/gateway-files'
import { type PushPayload, sendPushNotification } from '~/lib/push'
import { sendFcmNotification } from '~/lib/push-fcm'
import { bindWorktreeById, reserveFreshWorktree, rowToDto } from '~/lib/reserve-worktree'
import type {
  AgentSessionRow,
  ChainSummary,
  ContentBlock,
  ContextUsage,
  Env,
  KataSessionState,
  ProjectInfo,
  SpecStatusResponse,
  UserPreferencesRow,
  UserTabRow,
  VpStatusResponse,
} from '~/lib/types'
import { adminCodexModelsRoutes } from './admin-codex-models'
import { adminGeminiModelsRoutes } from './admin-gemini-models'
import { adminIdentitiesRoutes } from './admin-identities'
import { authMiddleware } from './auth-middleware'
import { authRoutes } from './auth-routes'
import { getRequestSession } from './auth-session'
import type { ApiAppEnv } from './context'
import { runWorktreesJanitor } from './scheduled'
import type { ReservedBy, SessionWorktreeParam, WorktreeRow } from './worktrees-types'

interface CreateSessionBody {
  project?: string
  prompt?: string | ContentBlock[]
  model?: string
  system_prompt?: string
  runner_session_id?: string
  agent?: string
  /** Optional GH issue number stamp — used by the kanban Start-next /
   *  drag-to-advance flow (GH#16 P3 U3) so the newly spawned session
   *  shows up in its chain immediately, before kata's own sync writes
   *  the value back. */
  kataIssue?: number
  /** Optional client-supplied session id for optimistic creation. When
   *  present, the DO is bound via `idFromName(client_session_id)` and the
   *  value is used verbatim as the D1 row id — letting the client render
   *  the new session instantly and fire POST /api/sessions in the
   *  background. Must not match the 64-char hex shape used by DO
   *  `idFromString` (see `getSessionDoId`). */
  client_session_id?: string
  /**
   * GH#115: optional worktree reservation. `{kind:'fresh'}` allocates a
   * fresh clone from the registry pool; `{id}` binds to an explicit id
   * (e.g. inherited from chain predecessor). Absent => no reservation;
   * the runner falls back to today's gateway-side project-path lookup.
   * See planning/specs/115-worktrees-first-class-resource.md §B-API-5.
   */
  worktree?: SessionWorktreeParam
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

const TAB_PATCH_KEYS = new Set(['sessionId', 'position', 'meta'])

const PREF_PATCH_KEYS = new Set([
  'permissionMode',
  'model',
  'codexModel',
  'maxBudget',
  'thinkingMode',
  'effort',
  'hiddenProjects',
  'chains',
  'chainsJson',
  'defaultChainAutoAdvance',
])

// Mirrors the Claude Agent SDK's `PermissionMode` union. Keep in sync
// with `PermissionMode` in `@duraclaw/shared-types` and the SDK's
// `sdk.d.ts`. `acceptAll` was historically accepted here but the SDK
// has no such mode — it would be silently demoted to `'default'` by
// the runner, so reject it at the API boundary.
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
])
const THINKING_MODES = new Set(['adaptive', 'enabled', 'disabled'])
// Mirrors the Claude Agent SDK's `EffortLevel` union (sdk.d.ts).
// `'xhigh'` was added in SDK v0.2.119 (Claude 4.7).
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function getDb(env: ApiAppEnv['Bindings']) {
  return drizzle(env.AUTH_DB, { schema })
}

/**
 * GH#115: validate a `ReservedBy` payload from a `POST /api/worktrees`
 * body. Accepts the three known kinds; `id` must be either a non-empty
 * string or a positive integer (kataIssue uses numeric id).
 */
function isValidReservedBy(value: unknown): value is ReservedBy {
  if (!value || typeof value !== 'object') return false
  const v = value as { kind?: unknown; id?: unknown }
  if (v.kind !== 'arc' && v.kind !== 'session' && v.kind !== 'manual') return false
  if (typeof v.id === 'string') return v.id.length > 0
  if (typeof v.id === 'number') return Number.isInteger(v.id) && v.id > 0
  return false
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

const fetchGatewayProjects = (env: ApiAppEnv['Bindings']): Promise<ProjectInfo[]> =>
  sharedFetchGatewayProjects(env as unknown as Env)

const _resolveProjectPath = (env: ApiAppEnv['Bindings'], projectName: string): Promise<string> =>
  sharedResolveProjectPath(env as unknown as Env, projectName)

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

/**
 * Spec #68 B4 — compose the WHERE fragment that scopes a session-list
 * query to what the caller is allowed to see.
 *   - admin + filter=all → no restriction (see everything)
 *   - filter=mine         → `user_id = :userId`
 *   - filter=all (default)→ `user_id = :userId OR visibility = 'public'`
 * Returns `undefined` when no restriction should be applied; callers
 * must skip `.where()` in that case or drop the scope from an `and(...)`.
 */
function buildSessionScope(userId: string, role: string, filter: 'mine' | 'all'): SQL | undefined {
  if (role === 'admin' && filter === 'all') return undefined
  if (filter === 'mine') return eq(agentSessions.userId, userId)
  return or(eq(agentSessions.userId, userId), eq(agentSessions.visibility, 'public'))
}

/**
 * Stamp an `isOwner: boolean` flag on each row against the supplied
 * caller userId. Centralises the pattern used by every
 * session-listing endpoint so the ownership rule lives in one place.
 */
function annotateOwnership<T extends { userId: string }>(
  rows: T[],
  userId: string,
): Array<T & { isOwner: boolean }> {
  return rows.map((r) => ({ ...r, isOwner: r.userId === userId }))
}

export async function getAccessibleSession(
  env: ApiAppEnv['Bindings'],
  sessionId: string,
  userId: string,
  role: string,
): Promise<{ ok: true; session: AgentSessionRow; isOwner: boolean } | { ok: false; status: 404 }> {
  const db = getDb(env)
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1)
  const row = rows[0]
  if (!row) return { ok: false, status: 404 }

  const isOwner = row.userId === userId || row.userId === 'system'
  const isPublic = row.visibility === 'public'
  const isAdmin = role === 'admin'

  if (!isOwner && !isPublic && !isAdmin) {
    return { ok: false, status: 404 }
  }

  return { ok: true, session: row as AgentSessionRow, isOwner }
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

// Chain-aggregation helpers (deriveIssueType / deriveColumn / findPrForIssue)
// now live in ~/lib/chains. The /api/chains handler consumes them indirectly
// via `buildChainRowFromContext` so the broadcast path shares the exact mapping.

// Gateway-file helpers (parseFrontmatter, fetchGatewayFile, listGatewayFiles,
// resolveProjectPath) live in ~/lib/gateway-files. Only fetchGatewayFile is
// still called inline below; it gets a thin alias so the rest of this file
// can pass the Hono-typed env without a cast at every call site.
const fetchGatewayFile = (env: ApiAppEnv['Bindings'], projectName: string, relPath: string) =>
  sharedFetchGatewayFile(env as unknown as Env, projectName, relPath)

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

    // Spec #68 B10 — tool approval is a write action on a live session;
    // public sessions allow any authed user to respond to a pending gate.
    const access = await getAccessibleSession(c.env, sessionId, userId, session.role)
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }

    if (typeof body.toolCallId !== 'string') {
      return c.json({ error: 'Invalid tool approval payload' }, 400)
    }

    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/tool-approval', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': access.session.id,
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

    // GH#115 P1.4: issue-closed releases the arc-bound reservation by
    // flipping the row to `cleanup` (the P1.7 janitor owns hard-delete
    // after grace, not this handler). Idempotent — a closed issue with
    // no active reservation produces 0 affected rows.
    const db = getDb(c.env)
    const now = Date.now()
    const updated = await db
      .update(worktrees)
      .set({ releasedAt: now, status: 'cleanup', lastTouchedAt: now })
      .where(
        and(
          sql`json_extract(${worktrees.reservedBy}, '$.kind') = 'arc'`,
          sql`json_extract(${worktrees.reservedBy}, '$.id') = ${issueNumber}`,
          isNull(worktrees.releasedAt),
        ),
      )
      .returning({ id: worktrees.id, path: worktrees.path })

    return c.json({
      released: true,
      issueNumber,
      deleted: updated.length,
      paths: updated.map((u) => u.path),
    })
  })

  // ── Gateway → Worker project sync (GH#32 phase p4) ────────────────
  //
  // Authoritative push path. The agent-gateway posts its current project
  // manifest here after every scan; we reconcile against D1 `projects`
  // (upsert present, soft-delete absent) then fan out a
  // synced-collection-delta frame to every UserSettingsDO with an active
  // WS (driven by the user_presence mirror).
  //
  // Bypasses authMiddleware — auth is Bearer CC_GATEWAY_SECRET, timing-safe.
  app.post('/api/gateway/projects/sync', async (c) => {
    const expected = c.env.CC_GATEWAY_SECRET
    if (!expected) {
      return c.json({ error: 'CC_GATEWAY_SECRET not configured' }, 401)
    }
    const authHeader = c.req.header('authorization') ?? ''
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!constantTimeEquals(provided, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const body = (await c.req.json().catch(() => null)) as {
      projects?: unknown
    } | null
    if (!body || !Array.isArray(body.projects)) {
      return c.json({ error: 'invalid body: expected {projects: ProjectInfo[]}' }, 400)
    }

    // Shape-check: `name` is the key, `path` (gateway ProjectInfo) maps onto
    // `rootPath` in D1. Additional ProjectInfo fields (branch, dirty, pr, …)
    // ride through in the delta frame but are NOT stored in D1.
    const incoming = body.projects as Array<ProjectInfo & { displayName?: string }>
    for (const p of incoming) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.path !== 'string') {
        return c.json({ error: 'invalid project shape' }, 400)
      }
    }

    const now = new Date().toISOString()
    const db = getDb(c.env)

    // Build the ops list from payload + existing D1 state. We do the SELECT
    // outside of any transaction so the reconcile can batch the writes.
    const existingRows = await db
      .select({ name: projectsTable.name, deletedAt: projectsTable.deletedAt })
      .from(projectsTable)
    const existingLive = new Set(existingRows.filter((r) => !r.deletedAt).map((r) => r.name))
    const incomingNames = new Set(incoming.map((p) => p.name))

    const ops: Array<import('@duraclaw/shared-types').SyncedCollectionOp<ProjectInfo>> = []

    // Upsert every row from the payload.
    for (const p of incoming) {
      await db
        .insert(projectsTable)
        .values({
          name: p.name,
          displayName: p.displayName ?? null,
          rootPath: p.path,
          updatedAt: now,
          deletedAt: null,
          // New projects default to 'public'. Admins can restrict via
          // PATCH /api/projects/:name/visibility; that value is preserved
          // across subsequent syncs (visibility omitted from the update
          // clause below).
          visibility: 'public',
        })
        .onConflictDoUpdate({
          target: projectsTable.name,
          set: {
            displayName: p.displayName ?? null,
            rootPath: p.path,
            updatedAt: now,
            deletedAt: null,
          },
        })

      ops.push({
        type: existingLive.has(p.name) ? 'update' : 'insert',
        value: p,
      })
    }

    // Soft-delete rows present in D1 but absent from the payload.
    const toDelete = [...existingLive].filter((name) => !incomingNames.has(name))
    if (toDelete.length > 0) {
      await db
        .update(projectsTable)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(projectsTable.name, toDelete))
      for (const name of toDelete) {
        ops.push({ type: 'delete', key: name })
      }
    }

    // Fan out to every active-presence user. Chunk ops to stay under the
    // 256 KiB /broadcast cap. `allSettled` so a dead DO doesn't abort
    // the rest — degraded users resync on next reconnect cycle.
    if (ops.length > 0) {
      const userRows = await db.select({ userId: userPresence.userId }).from(userPresence)
      const userIds = userRows.map((r) => r.userId)
      const chunks = chunkOps(ops, 200 * 1024)

      c.executionCtx.waitUntil(
        (async () => {
          for (const chunk of chunks) {
            const settled = await Promise.allSettled(
              userIds.map((uid) => broadcastSyncedDelta(c.env, uid, 'projects', chunk)),
            )
            settled.forEach((result, idx) => {
              if (result.status === 'rejected') {
                console.warn(`[projects/sync] broadcast failed user=${userIds[idx]}`, result.reason)
              }
            })
          }
        })(),
      )
    }

    return c.body(null, 204)
  })

  // ── Gateway → Worker worktree-discovery sweep (GH#115 P1.3) ───────
  //
  // Batch upsert of clones the gateway observed under /data/projects/.
  // Per B-DISCOVERY-1: idempotent INSERT-OR-UPDATE keyed by `path`.
  //   - INSERT: status derived from classification (free vs held);
  //     ownerId resolved from request payload → CC_DEFAULT_DISCOVERY_OWNER_USER_ID
  //     env fallback. Validates user exists; surfaces a per-clone error
  //     in errors[] if neither resolves.
  //   - UPDATE: refresh `branch` (when changed) + `lastTouchedAt`. Does
  //     NOT re-classify reservedBy / status / ownerId — those are sticky
  //     after first INSERT until explicit DELETE+re-INSERT.
  //
  // Per-clone errors do NOT fail the batch — they're returned in
  // `errors[]` so the gateway can log + retry on next sweep.
  //
  // Bypasses authMiddleware — auth is Bearer CC_GATEWAY_SECRET, timing-safe.
  app.post('/api/gateway/worktrees/upsert', async (c) => {
    const expected = c.env.CC_GATEWAY_SECRET
    if (!expected) {
      return c.json({ error: 'CC_GATEWAY_SECRET not configured' }, 401)
    }
    const authHeader = c.req.header('authorization') ?? ''
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!constantTimeEquals(provided, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const body = (await c.req.json().catch(() => null)) as {
      clones?: unknown
    } | null
    if (!body || !Array.isArray(body.clones)) {
      return c.json({ error: 'invalid body: expected {clones: SweptClone[]}' }, 400)
    }

    type IncomingClone = {
      path?: unknown
      branch?: unknown
      reservedBy?: unknown
      reservationOwnerUserId?: unknown
    }

    const upserted: Array<{ path: string; action: 'inserted' | 'updated' | 'unchanged' }> = []
    const errors: Array<{ path: string; error: string }> = []
    const fallbackOwner = c.env.CC_DEFAULT_DISCOVERY_OWNER_USER_ID ?? ''
    const db = getDb(c.env)

    // Cache the validated fallback owner per request — skip the users
    // SELECT on every clone in the batch.
    let fallbackOwnerValid: boolean | null = null
    async function fallbackOwnerExists(): Promise<boolean> {
      if (fallbackOwnerValid !== null) return fallbackOwnerValid
      if (!fallbackOwner) {
        fallbackOwnerValid = false
        return false
      }
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, fallbackOwner))
        .limit(1)
      fallbackOwnerValid = rows.length > 0
      return fallbackOwnerValid
    }

    const validatedOwners = new Map<string, boolean>()
    async function ownerExists(id: string): Promise<boolean> {
      if (validatedOwners.has(id)) return validatedOwners.get(id) as boolean
      const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1)
      const exists = rows.length > 0
      validatedOwners.set(id, exists)
      return exists
    }

    for (const raw of body.clones as IncomingClone[]) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof raw.path !== 'string' ||
        raw.path.length === 0
      ) {
        errors.push({
          path: typeof raw?.path === 'string' ? raw.path : '<unknown>',
          error: 'invalid_path',
        })
        continue
      }
      const cPath = raw.path
      const branch = typeof raw.branch === 'string' && raw.branch.length > 0 ? raw.branch : null

      // Validate reservedBy (matches isValidReservedBy contract).
      let reservedByJson: string | null = null
      if (raw.reservedBy !== undefined && raw.reservedBy !== null) {
        if (!isValidReservedBy(raw.reservedBy)) {
          errors.push({ path: cPath, error: 'invalid_reservedBy' })
          continue
        }
        reservedByJson = JSON.stringify(raw.reservedBy)
      }

      // Look up by `path` (UNIQUE).
      const existing = await db.select().from(worktrees).where(eq(worktrees.path, cPath)).limit(1)

      if (existing.length === 0) {
        // INSERT path. Resolve ownerId.
        let ownerId: string | null = null
        const requestedOwner =
          typeof raw.reservationOwnerUserId === 'string' && raw.reservationOwnerUserId.length > 0
            ? raw.reservationOwnerUserId
            : null

        if (requestedOwner) {
          if (await ownerExists(requestedOwner)) {
            ownerId = requestedOwner
          } else {
            errors.push({ path: cPath, error: 'invalid_owner' })
            continue
          }
        } else if (await fallbackOwnerExists()) {
          ownerId = fallbackOwner
        } else {
          errors.push({ path: cPath, error: 'no_owner_resolvable' })
          continue
        }

        const status = reservedByJson ? 'held' : 'free'
        const now = Date.now()
        // 16-char id matches the migration 0027 scheme (lower(hex(randomblob(8)))).
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16)

        try {
          await db.insert(worktrees).values({
            id,
            path: cPath,
            branch,
            status,
            reservedBy: reservedByJson,
            releasedAt: null,
            createdAt: now,
            lastTouchedAt: now,
            ownerId,
          })
          upserted.push({ path: cPath, action: 'inserted' })
        } catch (err) {
          // UNIQUE conflict on path is the most likely cause (concurrent
          // sweep insert) — re-read and treat as update on next pass.
          errors.push({
            path: cPath,
            error: `insert_failed: ${(err as Error).message ?? String(err)}`,
          })
        }
        continue
      }

      // UPDATE path. Refresh branch (if changed) + lastTouchedAt.
      // Sticky: do NOT update reservedBy / status / ownerId.
      const row = existing[0]
      const branchChanged = branch !== null && row.branch !== branch
      const now = Date.now()

      if (branchChanged) {
        await db
          .update(worktrees)
          .set({ branch, lastTouchedAt: now })
          .where(eq(worktrees.path, cPath))
        upserted.push({ path: cPath, action: 'updated' })
      } else {
        await db.update(worktrees).set({ lastTouchedAt: now }).where(eq(worktrees.path, cPath))
        upserted.push({ path: cPath, action: 'unchanged' })
      }
    }

    return c.json({ upserted, errors }, 200)
  })

  // ── Gateway reap-decision bridge ──────────────────────────────────────────
  // Posted by the gateway reaper on every kill/skip decision.
  // Bypasses authMiddleware — auth is Bearer CC_GATEWAY_SECRET, timing-safe.
  app.post('/api/gateway/sessions/:id/reap-decision', async (c) => {
    const expected = c.env.CC_GATEWAY_SECRET
    if (!expected) {
      return c.json({ error: 'CC_GATEWAY_SECRET not configured' }, 401)
    }
    const authHeader = c.req.header('authorization') ?? ''
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!constantTimeEquals(provided, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const body = (await c.req.json().catch(() => null)) as {
      decision?: unknown
      attrs?: unknown
    } | null

    const VALID_DECISIONS = ['skip-pending-gate', 'kill-stale', 'kill-dead-runner'] as const
    type ReapDecision = (typeof VALID_DECISIONS)[number]

    if (
      !body ||
      typeof body.decision !== 'string' ||
      !(VALID_DECISIONS as readonly string[]).includes(body.decision)
    ) {
      return c.json({ error: 'invalid request' }, 400)
    }

    const decision = body.decision as ReapDecision
    const attrs =
      body.attrs && typeof body.attrs === 'object' && !Array.isArray(body.attrs)
        ? (body.attrs as Record<string, unknown>)
        : {}

    const sessionId = c.req.param('id')
    const doId = getSessionDoId(c.env, sessionId)
    const stub = c.env.SESSION_AGENT.get(doId)

    try {
      // Cast: DO RPC types aren't auto-exposed on the stub; @callable routes correctly at runtime.
      await (
        stub as unknown as {
          recordReapDecision: (args: {
            decision: ReapDecision
            attrs: Record<string, unknown>
          }) => Promise<{ ok: true }>
        }
      ).recordReapDecision({ decision, attrs })
    } catch (err) {
      // SessionDO not found or RPC error — log and return 404
      console.warn(
        `[reap-decision] RPC failed sessionId=${sessionId} err=${(err as Error).message}`,
      )
      return c.json({ error: 'session not found' }, 404)
    }

    return c.json({ ok: true })
  })

  // Mobile OTA updater manifest — public endpoint (no auth). Capacitor
  // shell POSTs {platform, version_name}; we return {version, url} when the
  // deployed web bundle is newer, or {message} when it's current. The
  // worker reads `ota/version.json` from the `MOBILE_ASSETS` R2 bucket
  // (duraclaw-mobile) — written there by scripts/build-mobile-ota-bundle.sh
  // in the infra pipeline. When the bucket isn't bound (local dev, or
  // bucket not yet provisioned), we degrade silently to "no update".
  app.post('/api/mobile/updates/manifest', async (c) => {
    let body: { platform?: string; version_name?: string } = {}
    try {
      body = await c.req.json()
    } catch {}
    const current = body.version_name ?? ''

    if (!c.env.MOBILE_ASSETS) {
      return c.json({ message: 'No new version available' })
    }
    const obj = await c.env.MOBILE_ASSETS.get('ota/version.json')
    if (!obj) {
      return c.json({ message: 'No new version available' })
    }
    // Accept either `{ version, key }` (canonical — R2 object key) or the
    // legacy `{ version, path }` (Worker-asset URL path, pre-R2 shape).
    const manifest = (await obj.json()) as {
      version?: string
      key?: string
      path?: string
    }
    const key = manifest.key ?? manifest.path?.replace(/^\/mobile\//, 'ota/')
    if (!manifest.version || !key || manifest.version === current) {
      return c.json({ message: 'No new version available' })
    }
    const origin = new URL(c.req.url).origin
    return c.json({
      version: manifest.version,
      url: `${origin}/api/mobile/assets/${key}`,
    })
  })

  // Mobile native-APK manifest — public endpoint (no auth). Returns the
  // latest signed-APK version + URL so the Capacitor shell can prompt the
  // user to install a native-layer update (new plugin, Capacitor bump).
  // Reads `apk/version.json` from the `MOBILE_ASSETS` R2 bucket. Absence
  // → no APK available (common — only set when there's a real native bump).
  app.get('/api/mobile/apk/latest', async (c) => {
    if (!c.env.MOBILE_ASSETS) {
      return c.json({ message: 'No APK available' })
    }
    const obj = await c.env.MOBILE_ASSETS.get('apk/version.json')
    if (!obj) return c.json({ message: 'No APK available' })
    const manifest = (await obj.json()) as {
      version?: string
      key?: string
      path?: string
    }
    const key = manifest.key ?? manifest.path?.replace(/^\/mobile\//, 'apk/')
    if (!manifest.version || !key) {
      return c.json({ message: 'No APK available' })
    }
    const origin = new URL(c.req.url).origin
    return c.json({
      version: manifest.version,
      url: `${origin}/api/mobile/assets/${key}`,
    })
  })

  // Mobile asset passthrough — public endpoint (no auth). Streams R2
  // objects so the URLs returned by the manifest routes above are
  // same-origin Worker URLs. Keeps deploy surface minimal: no R2 public
  // custom domain, no pre-signed URLs, no extra CF config. 404s cleanly
  // when the bucket isn't bound or the key doesn't exist.
  app.get('/api/mobile/assets/*', async (c) => {
    if (!c.env.MOBILE_ASSETS) return c.body('Not found', 404)
    const url = new URL(c.req.url)
    const key = url.pathname.replace(/^\/api\/mobile\/assets\//, '')
    if (!key) return c.body('Not found', 404)
    const obj = await c.env.MOBILE_ASSETS.get(key)
    if (!obj) return c.body('Not found', 404)
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('ETag', obj.httpEtag)
    // Long cache — each release gets a unique key (bundle-<sha>.zip /
    // duraclaw-<ver>.apk), so mutating the "latest" pointer is a pure
    // version.json rewrite. No stale binaries.
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    return new Response(obj.body, { headers })
  })

  // ── Session media (R2-backed images) — GH#65 ─────────────────────
  // Streams image bytes from the SESSION_MEDIA R2 bucket. Placed before
  // authMiddleware so images render even when the session cookie is being
  // refreshed (img src tags don't carry credentials reliably in all
  // browsers). The R2 key itself is unguessable (contains session + msg id).
  app.get('/api/sessions/media/*', async (c) => {
    if (!c.env.SESSION_MEDIA) return c.body('Not found', 404)
    const url = new URL(c.req.url)
    const key = url.pathname.replace(/^\/api\/sessions\/media\//, '')
    if (!key) return c.body('Not found', 404)
    const obj = await c.env.SESSION_MEDIA.get(key)
    if (!obj) return c.body('Not found', 404)
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    headers.set('ETag', obj.httpEtag)
    // Immutable — each image has a unique key (session + message + part index).
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    return new Response(obj.body, { headers })
  })

  // GH#27 P1.1 (B2): projectMetadata UPSERT + read.
  //
  // Dual-auth (mirrors the B3 WS pattern, inline-style — same shape as
  // `/api/sessions/:id/tool-approval` above): accept EITHER a valid
  // Better Auth session cookie (browser path, e.g. the docs-worktree
  // modal) OR `Authorization: Bearer <DOCS_RUNNER_SECRET>` (gateway
  // path, called at project-discovery time). Bearer is checked
  // timing-safe via `constantTimeEquals`. When DOCS_RUNNER_SECRET is
  // unset, the bearer path is closed entirely (still 401).
  //
  // Mounted BEFORE `app.use('/api/*', authMiddleware)` so the bearer
  // path bypasses the cookie-only middleware.
  //
  // `projectId` URL param is constrained to exactly 16 lowercase hex
  // chars — matches the spec's `sha256(originUrl).slice(0,16)` shape
  // and the UUID-fallback (also 16 hex after stripping dashes). Any
  // other shape returns 400 to keep the surface area tight.
  const PROJECT_ID_RE = /^[0-9a-f]{16}$/

  function projectMetadataAuth(
    c: import('hono').Context<ApiAppEnv>,
  ): Promise<{ ok: true } | { ok: false; res: Response }> {
    const authHeader = c.req.header('authorization') ?? ''
    if (authHeader.startsWith('Bearer ')) {
      const expected = c.env.DOCS_RUNNER_SECRET
      const provided = authHeader.slice(7)
      if (expected && constantTimeEquals(provided, expected)) {
        return Promise.resolve({ ok: true } as const)
      }
      return Promise.resolve({
        ok: false as const,
        res: c.json({ error: 'Unauthorized' }, 401),
      })
    }
    // Fall back to session cookie auth.
    return getRequestSession(c.env, c.req.raw).then((session) => {
      if (!session) {
        return { ok: false as const, res: c.json({ error: 'Unauthorized' }, 401) }
      }
      return { ok: true as const }
    })
  }

  app.patch('/api/projects/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    if (!PROJECT_ID_RE.test(projectId)) {
      return c.json({ error: 'Invalid projectId' }, 400)
    }

    const auth = await projectMetadataAuth(c)
    if (!auth.ok) return auth.res

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Invalid body' }, 400)
    }

    // Validate field types. We accept missing keys (partial patch) and
    // accept `null` for nullable columns (originUrl, docsWorktreePath)
    // as an explicit "clear this column" signal. `projectName` is
    // NOT NULL in schema → reject explicit null.
    const patch: Partial<typeof projectMetadata.$inferInsert> = {}

    if ('projectName' in body) {
      const v = body.projectName
      if (typeof v !== 'string' || v.length === 0) {
        return c.json({ error: 'projectName must be a non-empty string' }, 400)
      }
      patch.projectName = v
    }
    if ('originUrl' in body) {
      const v = body.originUrl
      if (v !== null && typeof v !== 'string') {
        return c.json({ error: 'originUrl must be a string or null' }, 400)
      }
      patch.originUrl = v
    }
    if ('docsWorktreePath' in body) {
      const v = body.docsWorktreePath
      if (v !== null && typeof v !== 'string') {
        return c.json({ error: 'docsWorktreePath must be a string or null' }, 400)
      }
      patch.docsWorktreePath = v
    }
    if ('tombstoneGraceDays' in body) {
      const v = body.tombstoneGraceDays
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
        return c.json({ error: 'tombstoneGraceDays must be a positive integer' }, 400)
      }
      patch.tombstoneGraceDays = v
    }

    const knownKeys = new Set([
      'projectName',
      'originUrl',
      'docsWorktreePath',
      'tombstoneGraceDays',
    ])
    for (const key of Object.keys(body)) {
      if (!knownKeys.has(key)) {
        return c.json({ error: `Unknown field: ${key}` }, 400)
      }
    }

    const db = getDb(c.env)
    const now = new Date().toISOString()

    const existing = await db
      .select()
      .from(projectMetadata)
      .where(eq(projectMetadata.projectId, projectId))
      .limit(1)

    if (existing.length === 0) {
      // Insert path. `projectName` is NOT NULL — must be supplied on
      // first-touch unless we synthesise. Keep it strict: require
      // projectName on create. If not supplied, fall back to projectId
      // (so the gateway can call PATCH with `{}` and still create the
      // row — projectName is later overwritten on the next discovery).
      const inserted = await db
        .insert(projectMetadata)
        .values({
          projectId,
          projectName: patch.projectName ?? projectId,
          originUrl: patch.originUrl ?? null,
          docsWorktreePath: patch.docsWorktreePath ?? null,
          tombstoneGraceDays: patch.tombstoneGraceDays ?? 7,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      return c.json(inserted[0])
    }

    // Update path — merge supplied fields, advance updatedAt, leave
    // createdAt untouched.
    const updated = await db
      .update(projectMetadata)
      .set({ ...patch, updatedAt: now })
      .where(eq(projectMetadata.projectId, projectId))
      .returning()
    return c.json(updated[0])
  })

  app.get('/api/projects/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    if (!PROJECT_ID_RE.test(projectId)) {
      return c.json({ error: 'Invalid projectId' }, 400)
    }

    const auth = await projectMetadataAuth(c)
    if (!auth.ok) return auth.res

    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(projectMetadata)
      .where(eq(projectMetadata.projectId, projectId))
      .limit(1)
    if (rows.length === 0) {
      return c.json({ error: 'Project not found' }, 404)
    }
    return c.json(rows[0])
  })

  app.use('/api/*', authMiddleware)

  // GH#107 P2: admin-only codex_models CRUD. Mounted after authMiddleware
  // so `c.get('role')` is populated; the sub-app asserts admin role.
  app.route('/api/admin/codex-models', adminCodexModelsRoutes())

  // GH#110 P2: admin-only gemini_models CRUD. Mounted after authMiddleware
  // so `c.get('role')` is populated; the sub-app asserts admin role.
  app.route('/api/admin/gemini-models', adminGeminiModelsRoutes())

  // GH#119 P2: admin-only runner_identities CRUD. Same auth pattern as
  // codex-models. The DO reads this catalog on triggerGatewayDial and
  // selects an identity via LRU; the gateway sets HOME from the
  // derived path (`${IDENTITY_HOME_BASE}/${name}`, GH#129).
  app.route('/api/admin/identities', adminIdentitiesRoutes())

  // ── User settings (tabs) — direct D1 CRUD (B-API-2) ──────────────

  app.get('/api/user-settings/tabs', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)
    const tabs = await db
      .select()
      .from(userTabs)
      .where(and(eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))
      .orderBy(asc(userTabs.position))
    return c.json({ tabs: tabs as UserTabRow[] })
  })

  // session_viewers collection cold-start / reconnect resync. One row per
  // sessionId the caller has as a live tab; `viewers` lists other users
  // (excluding self) who also have the session as a live tab.
  app.get('/api/session-viewers', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)
    const viewers = await getSessionViewersForUser(db, userId)
    return c.json({ viewers })
  })

  app.post('/api/user-settings/tabs', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => null)) as {
      id?: string
      sessionId?: string | null
      position?: number
      meta?: string | null
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
        .where(and(eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))
      const max = maxRow[0]?.max
      position = typeof max === 'number' ? max + 1 : 0
    }

    const sessionId = body.sessionId ?? null
    const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const meta = typeof body.meta === 'string' ? body.meta : null

    // Insert-then-catch is the atomic dedup path: a partial unique index on
    // (user_id, session_id) WHERE deleted_at IS NULL AND session_id IS NOT NULL
    // (migration 0015) makes a concurrent second writer fail at INSERT rather
    // than slipping past a check-then-insert race. On constraint violation we
    // return the existing row with status 200 — same shape as a successful
    // dedup.
    try {
      const inserted = await db
        .insert(userTabs)
        .values({ id, userId, sessionId, position, createdAt, meta })
        .returning()
      const newRow = inserted[0] as UserTabRow
      c.executionCtx.waitUntil(broadcastTabsSnapshot(c.env, userId, db))
      if (sessionId) {
        c.executionCtx.waitUntil(fanoutSessionViewerChange(c.env, db, [sessionId]))
      }
      return c.json({ tab: newRow }, 201)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isUniqueViolation =
        sessionId !== null &&
        (msg.includes('UNIQUE constraint failed') || msg.includes('idx_user_tabs_live_session_uq'))
      if (!isUniqueViolation) throw err

      const existing = await db
        .select()
        .from(userTabs)
        .where(
          and(
            eq(userTabs.userId, userId),
            eq(userTabs.sessionId, sessionId as string),
            isNull(userTabs.deletedAt),
          ),
        )
        .limit(1)
      if (existing.length === 0) throw err
      // Re-broadcast the canonical row so a peer that POSTed concurrently with
      // a different optimistic id can converge onto it via the WS delta path
      // (the optimistic row stays orphaned otherwise — see openTab's local
      // dedup safeguard for the rendering side of the same race).
      const canonical = existing[0] as UserTabRow
      c.executionCtx.waitUntil(broadcastTabsSnapshot(c.env, userId, db))
      return c.json({ tab: canonical }, 200)
    }
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

    // Pre-select so we can detect a sessionId change and fan out viewers
    // for both the old and new session — the unique `(userId, sessionId)`
    // index means the user holds at most one live tab per sessionId, so
    // when sessionId moves they always lose their old-session row.
    const prevRows = await db
      .select({ sessionId: userTabs.sessionId })
      .from(userTabs)
      .where(and(eq(userTabs.id, tabId), eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))
      .limit(1)
    const prevSessionId = prevRows[0]?.sessionId ?? null

    const updated = await db
      .update(userTabs)
      .set(body as Partial<typeof userTabs.$inferInsert>)
      .where(and(eq(userTabs.id, tabId), eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))
      .returning()

    if (updated.length === 0) {
      return c.json({ error: 'Tab not found' }, 404)
    }

    const updatedRow = updated[0] as UserTabRow
    c.executionCtx.waitUntil(broadcastTabsSnapshot(c.env, userId, db))

    const nextSessionId = updatedRow.sessionId
    if (prevSessionId !== nextSessionId) {
      const affected: string[] = []
      if (prevSessionId) affected.push(prevSessionId)
      if (nextSessionId) affected.push(nextSessionId)
      if (affected.length > 0) {
        c.executionCtx.waitUntil(fanoutSessionViewerChange(c.env, db, affected, userId))
      }
    }
    return c.json({ tab: updatedRow })
  })

  app.delete('/api/user-settings/tabs/:id', async (c) => {
    const userId = c.get('userId')
    const tabId = c.req.param('id')
    const db = getDb(c.env)

    // Capture sessionId pre-delete so the session_viewers fanout can
    // drop this user from the row's viewer list and delete their local
    // row in one pass.
    const prevRows = await db
      .select({ sessionId: userTabs.sessionId })
      .from(userTabs)
      .where(and(eq(userTabs.id, tabId), eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))
      .limit(1)
    const prevSessionId = prevRows[0]?.sessionId ?? null

    const deleted = await db
      .update(userTabs)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(userTabs.id, tabId), eq(userTabs.userId, userId), isNull(userTabs.deletedAt)))
      .returning({ id: userTabs.id })

    if (deleted.length === 0) {
      return c.json({ error: 'Tab not found' }, 404)
    }

    c.executionCtx.waitUntil(broadcastTabsSnapshot(c.env, userId, db))
    if (prevSessionId) {
      c.executionCtx.waitUntil(fanoutSessionViewerChange(c.env, db, [prevSessionId], userId))
    }
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

    // D1 does not support interactive BEGIN/COMMIT transactions — drizzle's
    // `db.transaction()` throws on the D1 binding. Use `db.batch()` for
    // atomic multi-statement writes and do the ownership precheck with a
    // plain SELECT. A concurrent delete between the check and the batch is
    // a benign race: the batched UPDATEs filter by userId + deletedAt IS
    // NULL, so stale ids become no-ops rather than cross-user writes.
    const owned = await db
      .select({ id: userTabs.id })
      .from(userTabs)
      .where(
        and(eq(userTabs.userId, userId), inArray(userTabs.id, ids), isNull(userTabs.deletedAt)),
      )
    if (owned.length !== ids.length) {
      return c.json({ error: 'One or more ids not owned by caller' }, 400)
    }

    if (ids.length > 0) {
      const [first, ...rest] = ids.map((id, idx) =>
        db
          .update(userTabs)
          .set({ position: idx })
          .where(and(eq(userTabs.id, id), eq(userTabs.userId, userId), isNull(userTabs.deletedAt))),
      )
      await db.batch([first, ...rest])
    }

    c.executionCtx.waitUntil(broadcastTabsSnapshot(c.env, userId, db))
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
      model: 'claude-opus-4-7',
      codexModel: 'gpt-5.1',
      maxBudget: null,
      thinkingMode: 'adaptive',
      effort: 'xhigh',
      hiddenProjects: null,
      chainsJson: null,
      defaultChainAutoAdvance: false,
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

    // Accept both the documented public shape (`chains: {...}`, JS object) and
    // the collection write-through shape (`chainsJson: string` already
    // stringified). Both paths land in `chainsJson` column. Public API:
    // {chains: {"42": {autoAdvance: true}}} — server stringifies and stores.
    if (body.chains !== undefined && body.chains !== null) {
      const chains = body.chains
      if (typeof chains !== 'object' || Array.isArray(chains)) {
        return c.json({ error: 'chains must be an object' }, 400)
      }
      for (const [k, v] of Object.entries(chains as Record<string, unknown>)) {
        if (typeof k !== 'string') {
          return c.json({ error: 'Invalid chains shape' }, 400)
        }
        if (!/^\d+$/.test(k)) {
          return c.json({ error: 'Invalid chain key: must be a numeric issue number' }, 400)
        }
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          return c.json({ error: 'Invalid chains shape' }, 400)
        }
        const entry = v as Record<string, unknown>
        for (const ek of Object.keys(entry)) {
          if (ek !== 'autoAdvance') {
            return c.json({ error: 'Invalid chains shape' }, 400)
          }
        }
        if (entry.autoAdvance !== undefined && typeof entry.autoAdvance !== 'boolean') {
          return c.json({ error: 'Invalid chains shape' }, 400)
        }
      }
      body.chainsJson = JSON.stringify(chains)
      delete body.chains
    } else if (body.chains === null) {
      body.chainsJson = null
      delete body.chains
    }
    if (body.chainsJson !== undefined && body.chainsJson !== null) {
      if (typeof body.chainsJson !== 'string') {
        return c.json({ error: 'chainsJson must be a JSON string or null' }, 400)
      }
      // Validate parsed shape — defense-in-depth for the direct-write path.
      let parsed: unknown
      try {
        parsed = JSON.parse(body.chainsJson)
      } catch {
        return c.json({ error: 'chainsJson must be valid JSON' }, 400)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return c.json({ error: 'Invalid chains shape' }, 400)
      }
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof k !== 'string') {
          return c.json({ error: 'Invalid chains shape' }, 400)
        }
        if (!/^\d+$/.test(k)) {
          return c.json({ error: 'Invalid chain key: must be a numeric issue number' }, 400)
        }
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          return c.json({ error: 'Invalid chains shape' }, 400)
        }
        const entry = v as Record<string, unknown>
        for (const ek of Object.keys(entry)) {
          if (ek !== 'autoAdvance') {
            return c.json({ error: 'Invalid chains shape' }, 400)
          }
        }
        if (entry.autoAdvance !== undefined && typeof entry.autoAdvance !== 'boolean') {
          return c.json({ error: 'Invalid chains shape' }, 400)
        }
      }
    }
    if (
      body.defaultChainAutoAdvance !== undefined &&
      body.defaultChainAutoAdvance !== null &&
      typeof body.defaultChainAutoAdvance !== 'boolean'
    ) {
      return c.json({ error: 'defaultChainAutoAdvance must be a boolean' }, 400)
    }

    const updatedAt = new Date().toISOString()
    const db = getDb(c.env)
    const setValues = { ...(body as Partial<typeof userPreferences.$inferInsert>), updatedAt }
    const inserted = await db
      .insert(userPreferences)
      .values({ userId, ...setValues })
      .onConflictDoUpdate({ target: userPreferences.userId, set: setValues })
      .returning()

    const updatedRow = inserted[0] as UserPreferencesRow
    c.executionCtx.waitUntil(
      broadcastSyncedDelta(c.env, userId, 'user_preferences', [
        { type: 'update', value: updatedRow },
      ]),
    )
    return c.json({ preferences: updatedRow })
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

  /**
   * Debug FCM push — fans out to every `fcm_subscriptions` row for the
   * caller. Mirrors `/api/debug/push` but hits `sendFcmNotification()`
   * instead of the web-push path so we can verify the Capacitor-Android
   * delivery chain (APK → Firebase registration → server → FCM HTTP v1
   * → device notification tray) end-to-end from the device itself.
   *
   * Requires FCM_SERVICE_ACCOUNT_JSON on the Worker. Prunes gone tokens.
   */
  app.post('/api/debug/fcm-push', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string
      url?: string
      title?: string
      body?: string
      tag?: string
    }

    const sessionId = body.sessionId ?? ''
    const url = body.url ?? (sessionId ? `/?session=${sessionId}` : '/')
    const title = body.title ?? 'Duraclaw debug (FCM)'
    const payloadBody = body.body ?? `FCM debug push → ${url}`
    const tag = body.tag ?? 'debug-fcm-push'

    const serviceAccount = c.env.FCM_SERVICE_ACCOUNT_JSON
    if (!serviceAccount) {
      return c.json({ error: 'FCM_SERVICE_ACCOUNT_JSON not configured' }, 500)
    }

    const subsResult = await c.env.AUTH_DB.prepare(
      'SELECT id, token FROM fcm_subscriptions WHERE user_id = ?',
    )
      .bind(userId)
      .all<{ id: string; token: string }>()

    const subscriptions = subsResult.results
    if (subscriptions.length === 0) {
      return c.json(
        { error: 'No FCM tokens registered for this user — register on device first' },
        404,
      )
    }

    const payload: PushPayload = {
      title,
      body: payloadBody,
      url,
      tag,
      sessionId,
    }

    const results: Array<{
      id: string
      tokenHead: string
      ok: boolean
      status?: number
      gone?: boolean
    }> = []
    for (const sub of subscriptions) {
      const r = await sendFcmNotification(sub.token, payload, serviceAccount)
      results.push({
        id: sub.id,
        tokenHead: `${sub.token.slice(0, 20)}...`,
        ok: r.ok,
        status: r.status,
        gone: r.gone,
      })
      if (r.gone) {
        await c.env.AUTH_DB.prepare('DELETE FROM fcm_subscriptions WHERE id = ?').bind(sub.id).run()
      }
    }

    console.log(
      `[debug:fcm-push] userId=${userId} sent=${subscriptions.length} url=${url} results=${JSON.stringify(results)}`,
    )

    return c.json({ sent: subscriptions.length, results, payload })
  })

  app.get('/api/projects', async (c) => {
    const userId = c.get('userId')

    // D1-authoritative read (GH#32 p4). The agent-gateway pushes manifest
    // changes via POST /api/gateway/projects/sync; this handler surfaces
    // the reconciled D1 view, filtering deleted rows and the caller's
    // hidden-project preferences.
    const db = getDb(c.env)
    const hiddenSet = await getHiddenProjects(c.env, userId)

    const liveRows = await db
      .select()
      .from(projectsTable)
      .where(isNull(projectsTable.deletedAt))
      .orderBy(asc(projectsTable.name))

    const visibleRows =
      hiddenSet.size > 0 ? liveRows.filter((r) => !hiddenSet.has(r.name)) : liveRows

    // Per-project session merge (kept for parity with prior client
    // consumers that relied on `projects[i].sessions`). Session rows stay
    // in agent_sessions — unchanged by p4.
    const merged = await Promise.all(
      visibleRows.map(async (row) => {
        const sessions = await db
          .select()
          .from(agentSessions)
          .where(and(eq(agentSessions.userId, userId), eq(agentSessions.project, row.name)))
          .orderBy(desc(agentSessions.lastActivity))
        // D1 projects table only stores the minimal columns authoritative
        // to duraclaw. Live git-state fields (branch / dirty / ahead /
        // behind / pr) are populated by the gateway's push frame and
        // reach the client via synced-collection deltas; cold-start
        // consumers get neutral defaults here.
        const base: ProjectInfo = {
          name: row.name,
          path: row.rootPath,
          branch: 'unknown',
          dirty: false,
          active_session: null,
          repo_origin: null,
          ahead: 0,
          behind: 0,
          pr: null,
          // GH#84: surface admin-set tab overrides at cold-start so the
          // tab strip renders the chosen abbrev/color before the gateway
          // delta arrives. Both fields are NULL by default and fall back
          // to the auto-derivation in `lib/project-display.ts` when absent.
          abbrev: row.abbrev ?? null,
          color_slot: row.colorSlot ?? null,
        }
        return { ...base, sessions: sessions as AgentSessionRow[] }
      }),
    )

    return c.json({ projects: merged })
  })

  app.get('/api/sessions', async (c) => {
    const userId = c.get('userId')
    const role = c.get('role')
    const filter = (c.req.query('filter') === 'mine' ? 'mine' : 'all') as 'mine' | 'all'
    const scope = buildSessionScope(userId, role, filter)
    const db = getDb(c.env)
    const baseQuery = db.select().from(agentSessions)
    const rows = await (scope ? baseQuery.where(scope) : baseQuery)
      .orderBy(desc(agentSessions.lastActivity))
      .limit(200)
    const sessions = annotateOwnership(rows as AgentSessionRow[], userId)
    return c.json({ sessions })
  })

  app.get('/api/sessions/active', async (c) => {
    const userId = c.get('userId')
    const role = c.get('role')
    const filter = (c.req.query('filter') === 'mine' ? 'mine' : 'all') as 'mine' | 'all'
    const scope = buildSessionScope(userId, role, filter)
    const statusFilter = inArray(agentSessions.status, [...ACTIVE_STATUSES])
    const whereExpr = scope ? and(scope, statusFilter) : statusFilter
    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(agentSessions)
      .where(whereExpr)
      .orderBy(desc(agentSessions.lastActivity))
    const sessions = annotateOwnership(rows as AgentSessionRow[], userId)
    return c.json({ sessions })
  })

  app.get('/api/sessions/search', async (c) => {
    const q = c.req.query('q')
    if (!q) return c.json({ sessions: [] })
    const userId = c.get('userId')
    const role = c.get('role')
    const filter = (c.req.query('filter') === 'mine' ? 'mine' : 'all') as 'mine' | 'all'
    const scope = buildSessionScope(userId, role, filter)
    const needle = `%${q}%`
    const likeExpr = or(
      like(agentSessions.prompt, needle),
      like(agentSessions.project, needle),
      like(agentSessions.id, needle),
      like(agentSessions.title, needle),
      like(agentSessions.summary, needle),
      like(agentSessions.agent, needle),
      like(agentSessions.runnerSessionId, needle),
    )
    const whereExpr = scope ? and(scope, likeExpr) : likeExpr
    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(agentSessions)
      .where(whereExpr)
      .orderBy(desc(agentSessions.lastActivity))
      .limit(200)
    const sessions = annotateOwnership(rows as AgentSessionRow[], userId)
    return c.json({ sessions })
  })

  app.get('/api/sessions/history', async (c) => {
    const userId = c.get('userId')
    const role = c.get('role')
    const filter = (c.req.query('filter') === 'mine' ? 'mine' : 'all') as 'mine' | 'all'
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

    const scope = buildSessionScope(userId, role, filter)
    const filters: SQL[] = []
    if (scope) filters.push(scope)
    if (status) filters.push(eq(agentSessions.status, status))
    if (project) filters.push(eq(agentSessions.project, project))
    if (model) filters.push(eq(agentSessions.model, model))

    const db = getDb(c.env)
    const baseQuery = db.select().from(agentSessions)
    const rows = await (filters.length > 0 ? baseQuery.where(and(...filters)) : baseQuery)
      .orderBy(orderExpr)
      .limit(limit)
      .offset(offset)

    const sessions = annotateOwnership(rows as AgentSessionRow[], userId)
    return c.json({
      sessions,
      nextOffset: rows.length === limit ? offset + limit : null,
    })
  })

  app.get('/api/sessions/shared', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.visibility, 'public'), ne(agentSessions.userId, userId)))
      .orderBy(desc(agentSessions.lastActivity))
      .limit(200)
    const sessions = (rows as AgentSessionRow[]).map((r) => ({ ...r, isOwner: false }))
    return c.json({ sessions })
  })

  app.patch('/api/sessions/:id/visibility', async (c) => {
    const role = c.get('role')
    if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const sessionId = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { visibility?: string }
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      return c.json({ error: 'invalid_visibility' }, 400)
    }

    const db = getDb(c.env)
    const existing = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
    if (!existing[0]) return c.json({ error: 'Session not found' }, 404)

    await db
      .update(agentSessions)
      .set({ visibility: body.visibility, updatedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, sessionId))

    c.executionCtx.waitUntil(broadcastSessionRow(c.env, c.executionCtx, sessionId, 'update'))
    return c.json({ ok: true, visibility: body.visibility })
  })

  app.patch('/api/projects/:name/visibility', async (c) => {
    const role = c.get('role')
    if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const name = c.req.param('name')
    const body = (await c.req.json().catch(() => ({}))) as { visibility?: string }
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      return c.json({ error: 'invalid_visibility' }, 400)
    }

    const db = getDb(c.env)
    const now = new Date().toISOString()
    const result = await db
      .update(projectsTable)
      .set({ visibility: body.visibility, updatedAt: now })
      .where(eq(projectsTable.name, name))
      .returning({ name: projectsTable.name })
    if (!result[0]) return c.json({ error: 'Project not found' }, 404)

    // Re-read the full row so the synced-collection delta carries the
    // same ProjectInfo shape clients already rely on (branch, dirty, pr
    // come from the gateway endpoint and aren't stored here — we emit
    // an update op with the D1-known fields; clients merge into their
    // existing row via TanStack DB upsert semantics).
    const [row] = await db.select().from(projectsTable).where(eq(projectsTable.name, name)).limit(1)
    if (row) {
      const projectInfo: ProjectInfo = {
        name: row.name,
        path: row.rootPath,
        branch: 'unknown',
        dirty: false,
        active_session: null,
        repo_origin: null,
        ahead: 0,
        behind: 0,
        pr: null,
        visibility: (row.visibility === 'private' ? 'private' : 'public') as 'public' | 'private',
        // GH#84: include abbrev/colorSlot in every visibility broadcast so
        // a TanStack DB replace-upsert can't accidentally null them out
        // between syncs.
        abbrev: row.abbrev ?? null,
        color_slot: row.colorSlot ?? null,
      }
      const userRows = await db.select({ userId: userPresence.userId }).from(userPresence)
      const userIds = userRows.map((r) => r.userId)
      c.executionCtx.waitUntil(
        Promise.allSettled(
          userIds.map((uid) =>
            broadcastSyncedDelta(c.env, uid, 'projects', [{ type: 'update', value: projectInfo }]),
          ),
        ).then(() => undefined),
      )
    }

    return c.json({ ok: true, visibility: body.visibility })
  })

  // GH#84: per-project tab abbrev + color override. Admin-only, mirrors
  // the visibility PATCH pattern (D1 write + synced-collection broadcast
  // to every active-presence user). Both fields are independently
  // nullable — pass `null` to clear back to the auto-derivation. Omitted
  // fields are not touched.
  app.patch('/api/projects/:name/customization', async (c) => {
    const role = c.get('role')
    if (role !== 'admin') return c.json({ error: 'Forbidden' }, 403)

    const name = c.req.param('name')
    const body = (await c.req.json().catch(() => ({}))) as {
      abbrev?: string | null
      color_slot?: number | null
    }

    // Server-side validators mirror the client-side helpers in
    // `lib/project-display.ts` (`ABBREV_OVERRIDE_RE`,
    // `isValidColorSlotOverride`). Keep these in lockstep — if the
    // palette grows, both sides must update.
    const ABBREV_RE = /^[A-Z0-9]{1,2}$/
    const COLOR_SLOT_COUNT = 10

    const updates: { abbrev?: string | null; colorSlot?: number | null } = {}

    if (body.abbrev !== undefined) {
      if (body.abbrev === null) {
        updates.abbrev = null
      } else if (typeof body.abbrev === 'string' && ABBREV_RE.test(body.abbrev)) {
        updates.abbrev = body.abbrev
      } else {
        return c.json({ error: 'invalid_abbrev', detail: 'must match [A-Z0-9]{1,2}' }, 400)
      }
    }

    if (body.color_slot !== undefined) {
      if (body.color_slot === null) {
        updates.colorSlot = null
      } else if (
        typeof body.color_slot === 'number' &&
        Number.isInteger(body.color_slot) &&
        body.color_slot >= 0 &&
        body.color_slot < COLOR_SLOT_COUNT
      ) {
        updates.colorSlot = body.color_slot
      } else {
        return c.json(
          { error: 'invalid_color_slot', detail: `must be an integer in [0, ${COLOR_SLOT_COUNT})` },
          400,
        )
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'no_fields_to_update' }, 400)
    }

    const db = getDb(c.env)
    const now = new Date().toISOString()
    const result = await db
      .update(projectsTable)
      .set({ ...updates, updatedAt: now })
      .where(eq(projectsTable.name, name))
      .returning({ name: projectsTable.name })
    if (!result[0]) return c.json({ error: 'Project not found' }, 404)

    // Re-read the full row + broadcast — same shape contract as the
    // visibility PATCH so the client sees one canonical ProjectInfo per
    // delta, not partial patches.
    const [row] = await db.select().from(projectsTable).where(eq(projectsTable.name, name)).limit(1)
    if (row) {
      const projectInfo: ProjectInfo = {
        name: row.name,
        path: row.rootPath,
        branch: 'unknown',
        dirty: false,
        active_session: null,
        repo_origin: null,
        ahead: 0,
        behind: 0,
        pr: null,
        visibility: (row.visibility === 'private' ? 'private' : 'public') as 'public' | 'private',
        abbrev: row.abbrev ?? null,
        color_slot: row.colorSlot ?? null,
      }
      const userRows = await db.select({ userId: userPresence.userId }).from(userPresence)
      const userIds = userRows.map((r) => r.userId)
      c.executionCtx.waitUntil(
        Promise.allSettled(
          userIds.map((uid) =>
            broadcastSyncedDelta(c.env, uid, 'projects', [{ type: 'update', value: projectInfo }]),
          ),
        ).then(() => undefined),
      )
    }

    return c.json({
      ok: true,
      abbrev: row?.abbrev ?? null,
      color_slot: row?.colorSlot ?? null,
    })
  })

  // GH#27 P1.6 WU-B: GET /api/projects/:projectId/docs-files
  //
  // Proxy endpoint that lets the UI list markdown files in the project's
  // configured docs worktree. Reads `docsWorktreePath` from D1
  // `projectMetadata`, then proxies to the gateway's
  // `GET /docs-runners/:projectId/files?docsWorktreePath=...` directory
  // walker. The gateway is the only side with FS access; the worker just
  // forwards the call with the bearer-token gateway auth.
  //
  // Auth: cookie session (provided by `app.use('/api/*', authMiddleware)`
  // mounted above). Project-visibility is intentionally permissive for
  // v1 — see TODO below.
  //
  // Status semantics (per spec phase p5a):
  //   - 200      → forwarded gateway 200 body
  //   - 4xx      → forwarded gateway status + body
  //   - 502      → gateway responded but with 5xx
  //   - 503      → gateway unreachable / network failure / timeout. UI
  //                renders a retry chip on this code, NOT an empty state.
  //   - 404      → no projectMetadata row OR docsWorktreePath is null
  //                (project not configured for docs).
  app.get('/api/projects/:projectId/docs-files', async (c) => {
    const projectId = c.req.param('projectId')
    if (!PROJECT_ID_RE.test(projectId)) {
      return c.json({ error: 'Invalid projectId' }, 400)
    }

    // TODO(GH#27): once per-project visibility/ownership lands for
    // projectMetadata, gate this on the caller being a member of the
    // project. For v1 any authenticated user can read the file list —
    // the gateway validates `docsWorktreePath` server-side, so this
    // is not a path-traversal boundary.

    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(projectMetadata)
      .where(eq(projectMetadata.projectId, projectId))
      .limit(1)
    if (rows.length === 0 || !rows[0].docsWorktreePath) {
      return c.json(
        {
          error: 'project_not_configured',
          message: 'No docs worktree configured for this project',
        },
        404,
      )
    }
    const docsWorktreePath = rows[0].docsWorktreePath

    if (!c.env.CC_GATEWAY_URL) {
      return c.json({ error: 'CC_GATEWAY_URL not configured' }, 500)
    }
    const httpBase = c.env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const url = new URL(`/docs-runners/${projectId}/files`, httpBase)
    url.searchParams.set('docsWorktreePath', docsWorktreePath)

    const headers: Record<string, string> = {}
    if (c.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${c.env.CC_GATEWAY_SECRET}`
    }

    let resp: Response
    try {
      resp = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      return c.json({ error: 'gateway_unavailable' }, 503)
    }

    if (resp.status >= 500) {
      return c.json({ error: 'gateway_error', upstreamStatus: resp.status }, 502)
    }

    // 2xx and 4xx: forward body + status verbatim. Body is JSON for
    // the contract we care about; on the off-chance the gateway emits
    // a non-JSON response we still forward the bytes.
    const text = await resp.text()
    return new Response(text, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
    })
  })

  // GH#27 P1.7 WU-B: GET /api/docs-runners/:projectId/health
  //
  // Proxy to the gateway's `GET /docs-runners/:projectId/health`, which
  // in turn forwards the docs-runner's loopback `/health`. Used by the
  // docs route to drive per-file state indicators and the
  // ConfigMissingBanner (`config_present === false`).
  //
  // Status semantics:
  //   - upstream 200          → forward 200 + body
  //   - upstream 502          → pass through as-is (the gateway's
  //                             `docs_runner_unreachable` is not a gateway
  //                             error — the runner is down or not started)
  //   - upstream 5xx (other)  → 502 `gateway_error` with upstreamStatus
  //   - fetch throw / timeout → 503 `gateway_unavailable`
  //   - 404 if no projectMetadata row.
  app.get('/api/docs-runners/:projectId/health', async (c) => {
    const projectId = c.req.param('projectId')
    if (!PROJECT_ID_RE.test(projectId)) {
      return c.json({ error: 'Invalid projectId' }, 400)
    }

    const db = getDb(c.env)
    const rows = await db
      .select()
      .from(projectMetadata)
      .where(eq(projectMetadata.projectId, projectId))
      .limit(1)
    if (rows.length === 0) {
      return c.json(
        {
          error: 'project_not_configured',
          message: 'No metadata for this project',
        },
        404,
      )
    }

    if (!c.env.CC_GATEWAY_URL) {
      return c.json({ error: 'CC_GATEWAY_URL not configured' }, 500)
    }
    const httpBase = c.env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const url = new URL(`/docs-runners/${projectId}/health`, httpBase)

    const headers: Record<string, string> = {}
    if (c.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${c.env.CC_GATEWAY_SECRET}`
    }

    let resp: Response
    try {
      resp = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      return c.json({ error: 'gateway_unavailable' }, 503)
    }

    // 502 from the gateway is the docs-runner-unreachable signal —
    // pass through as-is so the UI can distinguish "runner down" from
    // "gateway down".
    if (resp.status === 502) {
      const text = await resp.text()
      return new Response(text, {
        status: 502,
        headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
      })
    }

    if (resp.status >= 500) {
      return c.json({ error: 'gateway_error', upstreamStatus: resp.status }, 502)
    }

    const text = await resp.text()
    const outHeaders: Record<string, string> = {
      'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
    }
    const ver = resp.headers.get('x-docs-runner-version')
    if (ver) outHeaders['X-Docs-Runner-Version'] = ver
    return new Response(text, { status: resp.status, headers: outHeaders })
  })

  // ── Feature Flags (GH#86) ─────────────────────────────────────────

  app.get('/api/admin/feature-flags', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    const db = getDb(c.env)
    const rows = await db.select().from(featureFlags)
    return c.json({ flags: rows })
  })

  app.patch('/api/admin/feature-flags/:id', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    const flagId = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null
    if (!body || typeof body.enabled !== 'boolean') {
      return c.json({ error: 'Body must include { enabled: boolean }' }, 400)
    }
    const db = getDb(c.env)
    const now = new Date().toISOString()
    await db
      .insert(featureFlags)
      .values({ id: flagId, enabled: body.enabled, updatedAt: now })
      .onConflictDoUpdate({
        target: featureFlags.id,
        set: { enabled: body.enabled, updatedAt: now },
      })
    return c.json({ ok: true, id: flagId, enabled: body.enabled })
  })

  // GH#115 §B-JANITOR-3: manual worktree sweep for operators. Runs the
  // same DELETE logic as the worker cron synchronously and returns the
  // deleted ids so an admin can confirm the result without tailing
  // wrangler logs. Same idle-window resolution as the cron (env
  // `CC_WORKTREE_IDLE_WINDOW_SECS`, default 24h).
  app.post('/api/admin/worktrees/sweep', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    const result = await runWorktreesJanitor(c.env as unknown as Env)
    return c.json(result, 200)
  })

  app.post('/api/sessions/sync', async (c) => {
    const _userId = c.get('userId')

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
      runner_session_id: string | null
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
    // D1 does not support interactive BEGIN/COMMIT — use db.batch() for
    // atomic multi-statement writes.
    const syncable = snapshots.filter((s) => {
      if (!s.runner_session_id) {
        skipped++
        return false
      }
      return true
    })
    const updateStmts = syncable.map((s) => {
      const runnerId = s.runner_session_id as string // guarded by filter above
      const lastActivity = s.last_activity_ts ? new Date(s.last_activity_ts).toISOString() : now
      const status = s.state === 'running' ? 'running' : 'idle'
      return db
        .update(agentSessions)
        .set({
          status,
          model: s.model ?? undefined,
          updatedAt: now,
          lastActivity: lastActivity,
          numTurns: s.turn_count || undefined,
          totalCostUsd: s.cost.usd || undefined,
        })
        .where(eq(agentSessions.runnerSessionId, runnerId))
    })

    if (updateStmts.length > 0) {
      const [first, ...rest] = updateStmts
      try {
        await db.batch([first, ...rest])
        updated = updateStmts.length
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[sync] batch update failed: ${message}`)
      }
    }

    return c.json({ updated, skipped, total: snapshots.length })
  })

  // ── Worktrees registry (GH#115) ──────────────────────────────────────
  // Reservable-resource API over /data/projects/* clones. See spec
  // planning/specs/115-worktrees-first-class-resource.md §B-API-1..5.
  // The legacy `worktreeReservations` table was dropped in P1.4; the
  // chain endpoints below now operate on this table directly.

  app.post('/api/worktrees', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => null)) as {
      kind?: string
      reservedBy?: unknown
    } | null
    if (!body || body.kind !== 'fresh' || !isValidReservedBy(body.reservedBy)) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const db = getDb(c.env)
    const result = await reserveFreshWorktree(db, body.reservedBy, userId)
    if (!result.ok) {
      return c.json(
        {
          error: 'pool_exhausted',
          freeCount: result.freeCount,
          totalCount: result.totalCount,
          hint: 'Run scripts/setup-clone.sh on the VPS to add a clone to the pool.',
        },
        503,
      )
    }
    return c.json(result.row, 200)
  })

  app.get('/api/worktrees', async (c) => {
    const userId = c.get('userId')
    const role = c.get('role')
    const status = c.req.query('status')
    const kind = c.req.query('kind')
    const id = c.req.query('id')
    const db = getDb(c.env)
    const conditions: SQL[] = []
    if (status) conditions.push(eq(worktrees.status, status))
    if (kind) conditions.push(sql`json_extract(${worktrees.reservedBy}, '$.kind') = ${kind}`)
    if (id) conditions.push(sql`json_extract(${worktrees.reservedBy}, '$.id') = ${id}`)
    // GH#115 review: scope to owner for non-admins.
    if (role !== 'admin') {
      conditions.push(eq(worktrees.ownerId, userId))
    }
    const rows = conditions.length
      ? await db
          .select()
          .from(worktrees)
          .where(and(...conditions))
      : await db.select().from(worktrees)
    return c.json({ worktrees: rows.map(rowToDto) })
  })

  app.post('/api/worktrees/:id/release', async (c) => {
    const userId = c.get('userId')
    const role = c.get('role')
    const id = c.req.param('id')
    const db = getDb(c.env)
    // Look up the row first to check ownership.
    const existing = await db.select().from(worktrees).where(eq(worktrees.id, id)).limit(1)
    if (existing.length === 0) return c.json({ error: 'not_found' }, 404)
    if (existing[0].ownerId !== userId && role !== 'admin') {
      return c.json({ error: 'not_owner' }, 403)
    }
    const now = Date.now()
    const updated = await db
      .update(worktrees)
      .set({ releasedAt: now, status: 'cleanup', lastTouchedAt: now })
      .where(eq(worktrees.id, id))
      .returning()
    return c.json(rowToDto(updated[0]), 200)
  })

  app.delete('/api/worktrees/:id', async (c) => {
    if (c.get('role') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    const id = c.req.param('id')
    const db = getDb(c.env)
    // Null out FK references first — the schema's
    // `agent_sessions.worktreeId REFERENCES worktrees(id)` has no
    // ON DELETE SET NULL clause (SQLite can't ALTER it post-creation),
    // so a referenced row would otherwise wedge on FK_CONSTRAINT_FAILED.
    await db
      .update(agentSessions)
      .set({ worktreeId: null, updatedAt: new Date().toISOString() })
      .where(eq(agentSessions.worktreeId, id))
    const deleted = await db
      .delete(worktrees)
      .where(eq(worktrees.id, id))
      .returning({ id: worktrees.id })
    if (deleted.length === 0) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true, id: deleted[0].id }, 200)
  })

  // ── Kata-CLI worktree reservation (GH#115 P1.6) ──────────────────────
  // Mirrors POST /api/worktrees but Bearer-authed via CC_GATEWAY_SECRET so
  // the kata CLI can reserve from an unauth shell context. The CLI runs
  // on the same VPS as the gateway and shares CC_GATEWAY_SECRET via
  // .env / .dev.vars; ownerId resolves to CC_DEFAULT_DISCOVERY_OWNER_USER_ID
  // (same fallback the gateway sweep uses on /api/gateway/worktrees/upsert).
  // Bypasses authMiddleware — auth is Bearer CC_GATEWAY_SECRET, timing-safe.
  app.post('/api/kata/worktrees/reserve', async (c) => {
    const expected = c.env.CC_GATEWAY_SECRET
    if (!expected) {
      return c.json({ error: 'CC_GATEWAY_SECRET not configured' }, 401)
    }
    const authHeader = c.req.header('authorization') ?? ''
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!constantTimeEquals(provided, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    const body = (await c.req.json().catch(() => null)) as {
      kind?: string
      reservedBy?: unknown
    } | null
    if (!body || body.kind !== 'fresh' || !isValidReservedBy(body.reservedBy)) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const fallbackOwner = c.env.CC_DEFAULT_DISCOVERY_OWNER_USER_ID ?? ''
    if (!fallbackOwner) {
      return c.json(
        { error: 'no_owner_resolvable', hint: 'Set CC_DEFAULT_DISCOVERY_OWNER_USER_ID' },
        503,
      )
    }

    const db = getDb(c.env)
    const result = await reserveFreshWorktree(db, body.reservedBy, fallbackOwner)
    if (!result.ok) {
      return c.json(
        {
          error: 'pool_exhausted',
          freeCount: result.freeCount,
          totalCount: result.totalCount,
          hint: 'Run scripts/setup-clone.sh on the VPS to add a clone to the pool.',
        },
        503,
      )
    }
    return c.json(result.row, 200)
  })

  app.post('/api/sessions', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json()) as CreateSessionBody

    const result = await createSession(
      c.env as unknown as Env,
      userId,
      {
        project: body.project ?? '',
        prompt: body.prompt,
        model: body.model,
        system_prompt: body.system_prompt,
        runner_session_id: body.runner_session_id,
        agent: body.agent,
        kataIssue: body.kataIssue,
        client_session_id: body.client_session_id,
        worktree: body.worktree,
      },
      c.executionCtx,
    )

    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 500 | 503)
    }
    return c.json({ session_id: result.sessionId }, 201)
  })

  app.get('/api/sessions/:id', async (c) => {
    const userId = c.get('userId')
    // Spec #68 B3 — read access widens to public + admin.
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // Merge: D1 metadata + DO runtime state. The DO owns live fields like
    // pending gates, current turn message id, etc. that are not in agent_sessions.
    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/state', {
        headers: {
          'x-partykit-room': access.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }

    const doState = (await response.json()) as Record<string, unknown>
    return c.json({ session: { ...access.session, ...doState } })
  })

  app.get('/api/sessions/:id/messages', async (c) => {
    const userId = c.get('userId')
    // Spec #68 B10 — read-access widens: public sessions + admin can view
    // message history, not just the owner.
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // GH#38 P1.2: cursor-REST forwarding. Both `sinceCreatedAt` and
    // `sinceId` must be supplied together (or both omitted for cold load).
    // The DO is the sole validator; we just pass the params through.
    const doUrl = new URL('https://session/messages')
    const sinceCreatedAt = c.req.query('sinceCreatedAt')
    const sinceId = c.req.query('sinceId')
    if (sinceCreatedAt !== undefined) doUrl.searchParams.set('sinceCreatedAt', sinceCreatedAt)
    if (sinceId !== undefined) doUrl.searchParams.set('sinceId', sinceId)

    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request(doUrl.toString(), {
        headers: {
          'x-partykit-room': access.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      // Propagate the DO's status + body verbatim so 400s from cursor
      // validation surface to the client as 400, not collapsed into 404.
      const text = await response.text()
      try {
        const parsed = JSON.parse(text)
        return c.json(parsed, response.status as 400 | 403 | 404 | 500)
      } catch {
        return c.json({ error: text || 'Session not found' }, response.status === 403 ? 403 : 404)
      }
    }

    // GH#38 P1.2: response body drops the legacy `version` field. The
    // `messageSeq` envelope now rides on the WS frame only; REST is just
    // a cold-load / reconnect-catchup channel.
    const body = (await response.json()) as { messages: unknown }
    return c.json({ messages: body.messages })
  })

  // GH#38 P1.2: optimistic user-turn ingest. The client's
  // `messagesCollection` onInsert mutationFn (P1.3) POSTs here with the
  // row it just optimistically wrote; the DO reuses `clientId` as the
  // persisted row id so the server echo reconciles via TanStack DB
  // deepEquals (no delete+insert churn on loopback).
  app.post('/api/sessions/:id/messages', async (c) => {
    // Wrap the entire handler so any unhandled throw (D1 read error, DO
    // fetch failure, JSON parse, etc.) surfaces as a JSON `{error}` body
    // instead of Hono's default plain-text "Internal Server Error". The
    // prior shape gave zero diagnostic signal for the message-send path
    // — the user just saw a blank 500 and we had to guess where in the
    // handler/DO chain the throw fired.
    const sessionId = c.req.param('id')
    try {
      const userId = c.get('userId')
      // Spec #68 B10 — sendMessage is a collaborative write action: public
      // sessions + admin may send turns; private sessions stay owner-only.
      const access = await getAccessibleSession(c.env, sessionId, userId, c.get('role'))
      if (!access.ok) {
        return c.json({ error: 'Session not found' }, 404)
      }

      let rawBody: unknown
      try {
        rawBody = await c.req.json()
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400)
      }
      const body = rawBody as {
        content?: unknown
        clientId?: unknown
        createdAt?: unknown
      }
      if (typeof body.content !== 'string' || body.content.length === 0) {
        return c.json({ error: 'content must be a non-empty string' }, 400)
      }
      if (typeof body.clientId !== 'string' || !/^usr-client-[a-z0-9-]+$/.test(body.clientId)) {
        return c.json({ error: 'clientId must match /^usr-client-[a-z0-9-]+$/' }, 400)
      }
      if (typeof body.createdAt !== 'string' || Number.isNaN(new Date(body.createdAt).getTime())) {
        return c.json({ error: 'createdAt must be a valid ISO 8601 string' }, 400)
      }

      const doId = getSessionDoId(c.env, access.session.id)
      const sessionDO = c.env.SESSION_AGENT.get(doId)
      const response = await sessionDO.fetch(
        new Request('https://session/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-partykit-room': access.session.id,
            'x-user-id': userId,
          },
          body: JSON.stringify({
            content: body.content,
            clientId: body.clientId,
            createdAt: body.createdAt,
            // Spec #68 B14 — stamp the turn with the sender's user id so
            // shared sessions can attribute user turns. The DO accepts
            // this as an optional opt for future multi-user display.
            senderId: userId,
          }),
        }),
      )

      const text = await response.text()
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        return c.json(parsed, response.status as 200 | 400 | 403 | 404 | 409 | 500)
      } catch {
        return c.json({ error: text || 'send failed' }, response.status as 400 | 500)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[POST /api/sessions/${sessionId}/messages] unhandled:`, err)
      return c.json({ error: msg }, 500)
    }
  })

  // P3 B4: REST endpoint for context usage. Scaffolding only — consumer
  // migration (swapping the client's WS `context_usage` handler to poll this)
  // is deferred to a separate issue per spec Non-Goals.
  app.get('/api/sessions/:id/context-usage', async (c) => {
    const userId = c.get('userId')
    // Spec #68 B10 — context usage is read-only; widen to public + admin.
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }
    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/context-usage', {
        headers: {
          'x-partykit-room': access.session.id,
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

  // GH#119 P1.1: dev-only transcript-entry count (VP-1 verification).
  // Gated on `ENABLE_DEBUG_ENDPOINTS === 'true'` — anything else 404s so
  // production deployments don't expose internal diagnostics. P3 reuses
  // the same gate for the simulate-rate-limit endpoint below.
  app.get('/api/sessions/:id/debug/transcript-count', async (c) => {
    if (c.env.ENABLE_DEBUG_ENDPOINTS !== 'true') {
      return c.json({ error: 'Not found' }, 404)
    }
    const userId = c.get('userId')
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }
    const sessionId = access.session.id
    const doId = getSessionDoId(c.env, sessionId)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    // Don't pass `session_id` here — the duraclaw session id is not the
    // SDK runner_session_id stored in `session_transcript.session_id`. The
    // DO resolves the correct id from its own `state.runner_session_id`.
    const response = await sessionDO.fetch(
      new Request('https://session/debug/transcript-count', {
        headers: {
          'x-partykit-room': sessionId,
          'x-user-id': userId,
        },
      }),
    )
    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }
    const body = (await response.json()) as { count: number }
    return c.json(body)
  })

  // GH#119 P3: dev-only failover trigger (VP-3 verification). Forwards an
  // optional `{ resets_at }` body to the DO's `/debug/simulate-rate-limit`
  // route which synthesises a real `RateLimitEvent` and routes it through
  // the failover handler. Gated on `ENABLE_DEBUG_ENDPOINTS === 'true'`.
  app.post('/api/sessions/:id/debug/simulate-rate-limit', async (c) => {
    if (c.env.ENABLE_DEBUG_ENDPOINTS !== 'true') {
      return c.json({ error: 'Not found' }, 404)
    }
    const userId = c.get('userId')
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }
    const sessionId = access.session.id
    const doId = getSessionDoId(c.env, sessionId)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    let bodyJson: string
    try {
      const raw = (await c.req.json().catch(() => null)) as { resets_at?: unknown } | null
      bodyJson = JSON.stringify(
        raw && typeof raw.resets_at === 'string' ? { resets_at: raw.resets_at } : {},
      )
    } catch {
      bodyJson = '{}'
    }
    const response = await sessionDO.fetch(
      new Request('https://session/debug/simulate-rate-limit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': sessionId,
          'x-user-id': userId,
        },
        body: bodyJson,
      }),
    )
    if (!response.ok) {
      return c.json({ error: 'Session not found' }, response.status === 403 ? 403 : 404)
    }
    const body = (await response.json()) as { ok: boolean }
    return c.json(body)
  })

  // P3 B5: REST endpoint for kata state, backed by the D1 mirror. Survives
  // runner teardown — the D1 row persists even when the runner is dead.
  app.get('/api/sessions/:id/kata-state', async (c) => {
    const userId = c.get('userId')
    // Spec #68 B10 — kata state is read-only; widen to public + admin.
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }
    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/kata-state', {
        headers: {
          'x-partykit-room': access.session.id,
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
    // GH#86 B4: any user-set title freezes the title forever (never-clobber
    // invariant). We stamp `title_source='user'` automatically — clients
    // never set it directly (it's not in SESSION_PATCH_KEYS).
    const patch: Partial<typeof agentSessions.$inferInsert> = {
      ...(body as Partial<typeof agentSessions.$inferInsert>),
      updatedAt,
    }
    if ('title' in body) {
      patch.titleSource = 'user'
    }
    const db = getDb(c.env)
    const updated = await db
      .update(agentSessions)
      .set(patch)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
      .returning()

    if (updated.length === 0) {
      // Either the session doesn't exist or it's owned by a different real
      // user — collapsed to 404 to avoid existence disclosure (B-API-1).
      return c.json({ error: 'Session not found' }, 404)
    }

    // GH#86 B4: also mirror the user-set title + provenance into the DO's
    // `session_meta` so the runner-event handler (`case 'title_update':`)
    // sees the freeze without a D1 round-trip on every event. Best-effort
    // — if the DO is cold or unreachable, the next title_update will be
    // discarded by the D1 source-of-truth check anyway.
    if ('title' in body) {
      const doId = getSessionDoId(c.env, sessionId)
      const sessionDO = c.env.SESSION_AGENT.get(doId)
      c.executionCtx.waitUntil(
        sessionDO
          .fetch(
            new Request('https://session/title-set-by-user', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-partykit-room': sessionId,
                'x-user-id': userId,
              },
              body: JSON.stringify({ title: (body as { title?: unknown }).title ?? null }),
            }),
          )
          .catch((err) => {
            console.warn(`[api] PATCH /api/sessions/${sessionId} DO sync failed:`, err)
          }),
      )
    }

    await broadcastSessionRow(c.env, c.executionCtx, sessionId, 'update')

    return c.json({ session: updated[0] as AgentSessionRow })
  })

  app.get('/api/gateway/projects', async (c) => {
    try {
      const projects = await fetchGatewayProjects(c.env)
      const userId = c.get('userId')
      const hiddenSet = await getHiddenProjects(c.env, userId)
      const db = getDb(c.env)
      // GH#84: pull abbrev/colorSlot alongside visibility so the tab strip
      // can read all admin-set overrides off projectsCollection without
      // waiting for a separate D1 round-trip.
      const d1Rows = await db
        .select({
          name: projectsTable.name,
          visibility: projectsTable.visibility,
          abbrev: projectsTable.abbrev,
          colorSlot: projectsTable.colorSlot,
        })
        .from(projectsTable)
      const d1Map = new Map(d1Rows.map((r) => [r.name, r]))
      const filtered =
        hiddenSet.size > 0 ? projects.filter((p) => !hiddenSet.has(p.name)) : projects
      return c.json(
        filtered.map((p) => {
          const meta = d1Map.get(p.name)
          return {
            ...p,
            visibility: meta?.visibility ?? 'private',
            abbrev: meta?.abbrev ?? null,
            color_slot: meta?.colorSlot ?? null,
          }
        }),
      )
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
      const db = getDb(c.env)
      // GH#84: same abbrev/colorSlot enrichment as `/api/gateway/projects`.
      const d1Rows = await db
        .select({
          name: projectsTable.name,
          visibility: projectsTable.visibility,
          abbrev: projectsTable.abbrev,
          colorSlot: projectsTable.colorSlot,
        })
        .from(projectsTable)
      const d1Map = new Map(d1Rows.map((r) => [r.name, r]))
      return c.json(
        projects.map((p) => {
          const meta = d1Map.get(p.name)
          return {
            ...p,
            hidden: hiddenSet.has(p.name),
            visibility: meta?.visibility ?? 'private',
            abbrev: meta?.abbrev ?? null,
            color_slot: meta?.colorSlot ?? null,
          }
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gateway unreachable'
      return c.json({ error: message }, 502)
    }
  })

  app.post('/api/sessions/:id/fork', async (c) => {
    const userId = c.get('userId')
    // Spec #68 B10 — fork is a collaborative write action: any user with
    // access (owner, public viewer, admin) may fork into a new session
    // they own.
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const body = (await c.req.json()) as {
      up_to_message_id?: string
      title?: string
      // GH#115 P1.5 / B-FORK-1: optional override. Default inherits parent's
      // worktreeId; explicit id binds via bindWorktreeById against the new
      // session id. Same-`reservedBy` re-acquire and free-eligible rows pass.
      worktreeId?: string
    }
    const projectName = access.session.project
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
    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const stateResp = await sessionDO.fetch(
      new Request('https://session/state', {
        headers: {
          'x-partykit-room': access.session.id,
          'x-user-id': userId,
        },
      }),
    )
    if (!stateResp.ok) {
      return c.json({ error: 'Could not read session state' }, 500)
    }
    const sessionState = (await stateResp.json()) as { runner_session_id?: string }
    const runnerSessionId = sessionState.runner_session_id
    if (!runnerSessionId) {
      return c.json({ error: 'Session has no runner session ID — cannot fork' }, 400)
    }

    // GH#115 P1.5 / B-FORK-1: resolve the worktreeId for the forked
    // session. Default inherits the parent's; the body may override with
    // any free-eligible or same-`reservedBy` clone. We bind eagerly
    // BEFORE the gateway POST so a 409/404 short-circuits without
    // creating a dangling SDK fork.
    const db = getDb(c.env)
    let resolvedWorktreeId: string | null = access.session.worktreeId ?? null
    if (typeof body.worktreeId === 'string' && body.worktreeId.length > 0) {
      const bind = await bindWorktreeById(
        db,
        body.worktreeId,
        { kind: 'session', id: access.session.id },
        userId,
      )
      if (!bind.ok && bind.kind === 'not_found') {
        return c.json({ error: 'worktree_not_found' }, 404)
      }
      if (!bind.ok && bind.kind === 'conflict') {
        return c.json({ error: 'worktree_conflict' }, 409)
      }
      if (bind.ok) {
        resolvedWorktreeId = bind.row.id
      }
    }

    const gatewayUrl = new URL(
      `/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(runnerSessionId)}/fork`,
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

    // GH#115 P1.5: persist worktreeId on the new agent_sessions row.
    // The gateway-driven INSERT may not have happened yet — UPSERT so
    // our value wins regardless of arrival order. Mirrors the minimal
    // baseRow shape used by `lib/create-session.ts`.
    if (resolvedWorktreeId) {
      try {
        const now = new Date().toISOString()
        // GH#115 review: inherit parent's agent/visibility/model/kataIssue
        // so Codex / private parents don't get silently rewritten to
        // claude+public on the fork UPSERT.
        await db
          .insert(agentSessions)
          .values({
            id: result.session_id,
            userId,
            project: projectName,
            status: 'running',
            model: access.session.model ?? null,
            agent: access.session.agent ?? 'claude',
            kataIssue: access.session.kataIssue ?? null,
            visibility: (access.session.visibility ?? 'public') as 'public' | 'private',
            createdAt: now,
            updatedAt: now,
            lastActivity: now,
            origin: 'duraclaw',
            archived: false,
            worktreeId: resolvedWorktreeId,
          } as typeof agentSessions.$inferInsert)
          .onConflictDoUpdate({
            target: agentSessions.id,
            set: { worktreeId: resolvedWorktreeId, updatedAt: now },
          })
      } catch (err) {
        console.error(
          `[fork] Failed to persist worktreeId=${resolvedWorktreeId} on session ${result.session_id}:`,
          err,
        )
      }
    }

    await broadcastSessionRow(c.env, c.executionCtx, result.session_id, 'insert')

    return c.json({ session_id: result.session_id })
  })

  app.post('/api/sessions/:id/abort', async (c) => {
    const userId = c.get('userId')
    // Spec #68 B10 — interrupt is a collaborative write action; widen to
    // public + admin.
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/abort', {
        method: 'POST',
        headers: {
          'x-partykit-room': access.session.id,
          'x-user-id': userId,
        },
      }),
    )

    if (!response.ok) {
      return c.json({ error: 'Abort failed' }, response.status === 403 ? 403 : 400)
    }

    return c.json({ status: 'idle' })
  })

  // Force-stop is the escalation lever for sessions where soft-abort
  // can't make progress — typically because the dial-back WS to the
  // runner is dead. The DO unilaterally flips → idle, drops the
  // callback token, clears any pending gate parts, AND HTTP-pings the
  // gateway to SIGTERM the runner PID out-of-band. Idempotent: safe
  // to call from any status, safe to call repeatedly.
  //
  // Owner OR admin (same widening as /abort) — this is a recovery
  // action a user must be able to invoke from devtools when the UI
  // affordance is hidden (Stop button only renders while
  // `isRunning`). Returns the gateway kill outcome verbatim so the
  // caller can tell apart "signalled" / "already_terminal" /
  // "not_found" / "unreachable" / "skipped" cases.
  app.post('/api/sessions/:id/force-stop', async (c) => {
    const userId = c.get('userId')
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }

    let reason: string | undefined
    try {
      const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null
      if (body && typeof body.reason === 'string') reason = body.reason
    } catch {
      // No body / non-JSON body — fall through with reason undefined.
    }

    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/force-stop', {
        method: 'POST',
        headers: {
          'x-partykit-room': access.session.id,
          'x-user-id': userId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: reason ?? 'force-stop via api' }),
      }),
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return c.json(
        { error: `Force-stop failed: ${text || response.statusText}` },
        response.status === 403 ? 403 : 500,
      )
    }

    // forceStop returns `{ok, kill}`; pass through so the caller can see
    // whether the gateway actually SIGTERM'd the runner.
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
    return c.json({ status: 'idle', ...result })
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

  app.post('/api/chains/:issue/checkout', async (c) => {
    const userId = c.get('userId')
    const issueNumber = Number.parseInt(c.req.param('issue'), 10)
    if (!Number.isFinite(issueNumber)) {
      return c.json({ error: 'Invalid issue number' }, 400)
    }

    // GH#115 P1.4: legacy body fields (`worktree`, `modeAtCheckout`) are
    // accepted for back-compat but ignored — the new helper keys on
    // `worktreeId` derived from the chain's most-recent session, and the
    // `mode` label is informational only.
    const body = (await c.req.json().catch(() => null)) as {
      worktree?: unknown
      modeAtCheckout?: unknown
    } | null
    const modeAtCheckout =
      body && typeof body.modeAtCheckout === 'string' && body.modeAtCheckout.length > 0
        ? body.modeAtCheckout
        : 'implementation'

    const db = getDb(c.env)

    // Resolve issueNumber -> worktreeId via the chain's most-recent
    // session that has a worktreeId. Mirrors the resolution in
    // `buildChainRow` (~/lib/chains.ts) so the checkout binds the
    // already-allocated row instead of re-allocating from the pool.
    const sessionRows = await db
      .select({ worktreeId: agentSessions.worktreeId })
      .from(agentSessions)
      .where(eq(agentSessions.kataIssue, issueNumber))
      .orderBy(desc(agentSessions.createdAt))
    const sessionWithWt = sessionRows.find((s) => s.worktreeId)
    const worktreeId = sessionWithWt?.worktreeId ?? null

    if (!worktreeId) {
      return c.json(
        {
          error: 'no_worktree_for_chain',
          hint: 'Reserve via POST /api/worktrees first, or spawn a session with worktree:{kind:"fresh"}',
        },
        400,
      )
    }

    const result = await checkoutWorktree(
      db,
      { worktreeId, mode: modeAtCheckout, reservedBy: { kind: 'arc', id: issueNumber } },
      userId,
    )

    if (result.ok) {
      // The reservation lives on `ChainSummary.worktreeReservation`;
      // without this broadcast the board card's "checked out" badge
      // and conflict detection lag behind the actual D1 state.
      await broadcastChainRow(c.env, c.executionCtx, issueNumber, { actorUserId: userId })
      return c.json({ reservation: result.reservation })
    }
    if (result.status === 409) {
      return c.json({ conflict: result.conflict, message: result.message }, 409)
    }
    if (result.status === 404) {
      return c.json({ error: result.error }, 404)
    }
    return c.json({ error: result.error }, 500)
  })

  app.post('/api/chains/:issue/release', async (c) => {
    const userId = c.get('userId')
    const issueNumber = Number.parseInt(c.req.param('issue'), 10)
    if (!Number.isFinite(issueNumber)) {
      return c.json({ error: 'Invalid issue number' }, 400)
    }

    // GH#115 P1.4: release flips the arc-bound row to `cleanup` instead
    // of hard-deleting (the P1.7 janitor owns hard-delete after grace).
    // Owner-only; non-owners must use /force-release (stale gate).
    const db = getDb(c.env)
    const targets = await db
      .select()
      .from(worktrees)
      .where(
        and(
          sql`json_extract(${worktrees.reservedBy}, '$.kind') = 'arc'`,
          sql`json_extract(${worktrees.reservedBy}, '$.id') = ${issueNumber}`,
          isNull(worktrees.releasedAt),
        ),
      )
    if (targets.length === 0) {
      // Idempotent — no reservation means nothing to release.
      return c.json({ released: true, count: 0 })
    }

    const nonOwned = targets.filter((r) => r.ownerId !== userId)
    if (nonOwned.length > 0) {
      return c.json({ error: 'not_owner', reservation: rowToDto(nonOwned[0]) }, 403)
    }

    const now = Date.now()
    for (const r of targets) {
      await db
        .update(worktrees)
        .set({ releasedAt: now, status: 'cleanup', lastTouchedAt: now })
        .where(eq(worktrees.id, r.id))
      await db.insert(auditLog).values({
        action: 'reservation_released',
        userId,
        details: JSON.stringify({ issueNumber, worktreeId: r.id, path: r.path }),
      })
    }

    // Reservation removal flips the chain card's badge — fanout the
    // rebuilt summary so every connected board repaints.
    await broadcastChainRow(c.env, c.executionCtx, issueNumber, { actorUserId: userId })

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
    // GH#115 P1.4: legacy `worktree` (project-name) filter still accepted;
    // applied as a path-suffix match against the new `worktrees.path`
    // (`/data/projects/<name>`) so old clients stay wired.
    const worktreeFilter = typeof body.worktree === 'string' ? body.worktree : undefined

    const db = getDb(c.env)
    const baseWhere = and(
      sql`json_extract(${worktrees.reservedBy}, '$.kind') = 'arc'`,
      sql`json_extract(${worktrees.reservedBy}, '$.id') = ${issueNumber}`,
    )
    const targets = worktreeFilter
      ? await db
          .select()
          .from(worktrees)
          .where(and(baseWhere, eq(worktrees.path, `/data/projects/${worktreeFilter}`)))
      : await db.select().from(worktrees).where(baseWhere)

    if (targets.length === 0) {
      return c.json({ message: 'No reservation for this chain' }, 404)
    }

    const staleCutoff = Date.now() - FORCE_RELEASE_STALE_MS
    for (const r of targets) {
      const isStale = r.lastTouchedAt < staleCutoff
      if (!isStale) {
        return c.json(
          {
            message: 'Reservation not stale enough',
            staleAfterDays: FORCE_RELEASE_STALE_DAYS,
            lastActivity: new Date(r.lastTouchedAt).toISOString(),
          },
          403,
        )
      }
    }

    // All targets pass the gate — flip to cleanup + audit. Janitor (P1.7)
    // owns hard-delete after grace.
    const now = Date.now()
    for (const r of targets) {
      await db
        .update(worktrees)
        .set({ releasedAt: now, status: 'cleanup', lastTouchedAt: now })
        .where(eq(worktrees.id, r.id))
      await db.insert(auditLog).values({
        action: 'force_release_worktree',
        userId,
        details: JSON.stringify({
          issueNumber,
          worktreeId: r.id,
          path: r.path,
          previousOwner: r.ownerId,
          createdAt: r.createdAt,
        }),
      })
    }

    // Same rationale as `/release` — the chain card's reservation badge
    // changes shape and every connected board needs to repaint.
    await broadcastChainRow(c.env, c.executionCtx, issueNumber, { actorUserId: userId })

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

    // GH#115 P1.4: chain reservation is the worktrees row referenced by
    // ANY session in the chain (all arc sessions share one FK). Bulk-
    // fetch the unique non-null worktreeIds, then resolve per-issue.
    const worktreeIds = Array.from(
      new Set(allSessions.map((s) => s.worktreeId).filter((x): x is string => !!x)),
    )
    const allWorktrees = worktreeIds.length
      ? await db.select().from(worktrees).where(inArray(worktrees.id, worktreeIds))
      : []
    const worktreeById = new Map(allWorktrees.map((w) => [w.id, w]))

    const reservationByIssue = new Map<number, WorktreeRow | null>()
    for (const issueNumber of allIssueNumbers) {
      const sessions = sessionsByIssue.get(issueNumber) ?? []
      const sessionWithWt = sessions.find((s) => s.worktreeId)
      if (sessionWithWt?.worktreeId) {
        const w = worktreeById.get(sessionWithWt.worktreeId)
        reservationByIssue.set(issueNumber, w ? rowToDto(w) : null)
      } else {
        reservationByIssue.set(issueNumber, null)
      }
    }

    // 4. Build ChainSummary[] via the shared `buildChainRowFromContext`
    //    mapping so the broadcast path in SessionDO produces byte-identical
    //    rows (same aggregation, same column derivation, same PR matching).
    const buildCtx: ChainBuildContext = { ghIssueByNumber, pulls }
    const chains: ChainSummary[] = []
    for (const issueNumber of allIssueNumbers) {
      const sessions = sessionsByIssue.get(issueNumber) ?? []
      const reservation = reservationByIssue.get(issueNumber) ?? null

      const mappedSessions = sessions.map((s) => ({
        id: s.id,
        kataMode: s.kataMode,
        status: s.status,
        lastActivity: s.lastActivity,
        createdAt: s.createdAt,
        project: s.project,
      }))

      const chain = buildChainRowFromContext(issueNumber, mappedSessions, reservation, buildCtx)
      if (!chain) continue

      // Preserve a reference to the underlying rows for filter logic — the
      // mapped `sessions` on the chain object has user_id stripped, so
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
    // Single source of truth lives in `lib/gateway-files.ts:getSpecStatus`.
    // Resolution order: frontmatter `github_issue:` first (canonical),
    // then filename prefix `^0*<n>-.*\.md$` (legacy / leading-zero
    // tolerant). See helper docs for cost characteristics.
    const result = await sharedGetSpecStatus(c.env, project, issueNumber)
    return c.json<SpecStatusResponse>(result)
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
    // Spec #68 B10 — resolve-gate is a collaborative write action on a
    // pending gate; any user with access can respond.
    const access = await getAccessibleSession(c.env, c.req.param('id'), userId, c.get('role'))
    if (!access.ok) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const body = (await c.req.json()) as {
      answers?: Record<string, string>
      toolCallId?: string
    }
    if (!body.answers || typeof body.answers !== 'object') {
      return c.json({ error: 'Invalid answers payload' }, 400)
    }

    const doId = getSessionDoId(c.env, access.session.id)
    const sessionDO = c.env.SESSION_AGENT.get(doId)
    const response = await sessionDO.fetch(
      new Request('https://session/answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partykit-room': access.session.id,
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

  // GET /api/deploys/state — admin-only proxy to the agent-gateway's
  // /deploy/state, which in turn reads baseplane-infra's `.deploy-state.json`.
  // Mirrors the data that `pnpm tui` renders on the VPS.
  app.get('/api/deploys/state', async (c) => {
    const userId = c.get('userId')
    const userRow = await c.env.AUTH_DB.prepare('SELECT role FROM users WHERE id = ?')
      .bind(userId)
      .first<{ role: string | null }>()
    if (userRow?.role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    if (!c.env.CC_GATEWAY_URL) {
      return c.json({ error: 'Gateway not configured' }, 503)
    }

    const httpBase = c.env.CC_GATEWAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const gatewayUrl = new URL('/deploy/state', httpBase)
    // Forward the repo selector from the UI. Gateway whitelists the value.
    const repo = c.req.query('repo')
    if (repo) gatewayUrl.searchParams.set('repo', repo)
    const headers: Record<string, string> = {}
    if (c.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${c.env.CC_GATEWAY_SECRET}`
    }

    try {
      const resp = await fetch(gatewayUrl.toString(), {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      const body = await resp.text()
      return new Response(body, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: `Gateway unreachable: ${message}` }, 502)
    }
  })

  return app
}
