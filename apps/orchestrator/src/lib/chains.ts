/**
 * Chain aggregation helpers (GH#32 phase p5).
 *
 * The `/api/chains` handler and the SessionDO broadcast path both need
 * the same ChainSummary row shape, so the mapping lives here as a
 * reusable pure function. GitHub metadata (issue title/state/type,
 * matching PR) is fetched lazily via the shared cache in the API module;
 * for the broadcast path we inline a slimmed GH fetch behind the same
 * module-level caches so hot session turns don't thrash the GH rate limit.
 *
 * `buildChainRow(db, userId, issueNumber)` returns the current chain for a
 * single issue or `null` if the chain is empty (no sessions AND the issue
 * is not visible via GH). Callers in session-do.ts translate `null` into
 * a `{type:'delete'}` op so empty chains disappear from user clients.
 */

import { asc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { agentSessions, worktreeReservations } from '~/db/schema'
import type { ChainSummary, Env } from '~/lib/types'

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>

// ─── GH cache (shared with /api/chains consumers but scoped to this module) ──

interface GhIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  updated_at?: string
  labels?: Array<{ name: string }>
  pull_request?: unknown
}

interface GhPull {
  number: number
  head?: { ref?: string }
  body?: string | null
}

interface GhIssueCacheEntry {
  issues: GhIssue[]
  expiresAt: number
}

interface GhPullCacheEntry {
  pulls: GhPull[]
  expiresAt: number
}

const GH_CACHE_TTL_MS = 5 * 60 * 1000
const ghIssueCache = new Map<string, GhIssueCacheEntry>()
const ghPullCache = new Map<string, GhPullCacheEntry>()

function ghHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'duraclaw',
  }
  if (env.GITHUB_API_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_API_TOKEN}`
  }
  return headers
}

async function fetchGhIssuesCached(env: Env): Promise<GhIssue[]> {
  const repo = env.GITHUB_REPO
  if (!repo) return []
  const cached = ghIssueCache.get(repo)
  if (cached && cached.expiresAt > Date.now()) return cached.issues

  const all: GhIssue[] = []
  for (let page = 1; page <= 3; page++) {
    const url = `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`
    const resp = await fetch(url, { headers: ghHeaders(env) })
    if (!resp.ok) return all
    const batch = (await resp.json()) as GhIssue[]
    all.push(...batch)
    if (batch.length < 100) break
  }
  ghIssueCache.set(repo, { issues: all, expiresAt: Date.now() + GH_CACHE_TTL_MS })
  return all
}

async function fetchGhPullsCached(env: Env): Promise<GhPull[]> {
  const repo = env.GITHUB_REPO
  if (!repo) return []
  const cached = ghPullCache.get(repo)
  if (cached && cached.expiresAt > Date.now()) return cached.pulls

  const all: GhPull[] = []
  for (let page = 1; page <= 3; page++) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100&page=${page}`
    const resp = await fetch(url, { headers: ghHeaders(env) })
    if (!resp.ok) return all
    const batch = (await resp.json()) as GhPull[]
    all.push(...batch)
    if (batch.length < 100) break
  }
  ghPullCache.set(repo, { pulls: all, expiresAt: Date.now() + GH_CACHE_TTL_MS })
  return all
}

// ─── Column + type derivation (shared with /api/chains) ──────────────────────

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
 * Predicate: has this chain session finished at least one turn and is no
 * longer the live frontier?
 *
 * `agent_sessions.status` never holds `'completed'` in this codebase —
 * the `SessionStatus` union (packages/shared-types) is
 * `'idle' | 'pending' | 'running' | 'waiting_*' | 'error'`. Finished
 * sessions park as `'idle'`. `lastActivity != null` means at least one
 * turn ran (we don't treat a freshly-spawned `'pending'` row as completed).
 *
 * Shared between:
 *   - use-chain-preconditions (client manual-advance gate)
 *   - KanbanCard status label rendering
 *   - ChainStatusItem rung-completed bit (where the original predicate
 *     was introduced — now canonical here)
 *   - SessionDO prior-artifacts accumulator (kata entrance prompt)
 *
 * @see planning/research/2026-04-23-chain-feature-not-functional.md §1
 */
export function isChainSessionCompleted(session: {
  status: string
  lastActivity: string | null
}): boolean {
  return session.status === 'idle' && session.lastActivity != null
}

export function deriveIssueType(
  labels: Array<{ name: string }> | undefined,
): 'bug' | 'enhancement' | 'other' {
  const names = new Set((labels ?? []).map((l) => l.name))
  if (names.has('bug')) return 'bug'
  if (names.has('enhancement')) return 'enhancement'
  return 'other'
}

export function deriveColumn(
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

export function findPrForIssue(pulls: GhPull[], issueNumber: number): number | undefined {
  for (const pr of pulls) {
    const branch = pr.head?.ref ?? ''
    const branchMatch = branch.match(/^(?:feature|fix|feat)\/(\d+)[-_]/)
    if (branchMatch && Number.parseInt(branchMatch[1], 10) === issueNumber) {
      return pr.number
    }
    const body = pr.body ?? ''
    const bodyRe = new RegExp(`(?:closes|fixes)\\s+#${issueNumber}(?![0-9])`, 'i')
    if (bodyRe.test(body)) {
      return pr.number
    }
  }
  return undefined
}

// ─── Core buildChainRow ───────────────────────────────────────────────────────

/**
 * Pre-fetched context for batch callers (the /api/chains handler). The
 * broadcast path uses the simpler `buildChainRow(env, db, userId, issue)`
 * signature which fetches its own GH data lazily via the module cache.
 */
export interface ChainBuildContext {
  ghIssueByNumber: Map<number, GhIssue>
  pulls: GhPull[]
}

export async function loadChainBuildContext(env: Env): Promise<ChainBuildContext> {
  const [issues, pulls] = await Promise.all([fetchGhIssuesCached(env), fetchGhPullsCached(env)])
  const ghIssueByNumber = new Map<number, GhIssue>()
  for (const issue of issues) {
    if (issue.pull_request) continue
    ghIssueByNumber.set(issue.number, issue)
  }
  return { ghIssueByNumber, pulls }
}

/**
 * Pure mapping — builds the ChainSummary row for a single issue given
 * pre-fetched sessions, reservation, and GH context. Returns null if the
 * chain is empty (no sessions AND no GH issue metadata).
 */
export function buildChainRowFromContext(
  issueNumber: number,
  sessions: Array<{
    id: string
    kataMode: string | null
    status: string
    lastActivity: string | null
    createdAt: string
    project: string
  }>,
  reservation: {
    worktree: string
    heldSince: string
    lastActivityAt: string
    ownerId: string
    stale: boolean | null
  } | null,
  ctx: ChainBuildContext,
): ChainSummary | null {
  const ghIssue = ctx.ghIssueByNumber.get(issueNumber)

  // Empty chain: no sessions AND the GH issue isn't visible in our cached
  // window. The row has nothing to render — caller should emit a delete.
  if (sessions.length === 0 && !ghIssue) return null

  let issueTitle: string
  let issueState: 'open' | 'closed'
  let issueType: string
  if (ghIssue) {
    issueTitle = ghIssue.title
    issueState = ghIssue.state
    issueType = deriveIssueType(ghIssue.labels)
  } else {
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

  const worktreeReservation = reservation
    ? {
        worktree: reservation.worktree,
        heldSince: reservation.heldSince,
        lastActivityAt: reservation.lastActivityAt,
        ownerId: reservation.ownerId,
        stale: !!reservation.stale,
      }
    : null

  const prNumber = findPrForIssue(ctx.pulls, issueNumber)

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
  if (!lastActivity) lastActivity = ghIssue?.updated_at ?? ''

  const chain: ChainSummary = {
    issueNumber,
    issueTitle,
    issueType,
    issueState,
    column,
    sessions,
    worktreeReservation,
    lastActivity,
    ...(prNumber !== undefined ? { prNumber } : {}),
  }
  return chain
}

/**
 * Broadcast-path helper: rebuild a single chain row from scratch for
 * `issueNumber`. Called from SessionDO after D1 writes commit. Returns
 * `null` when the chain has no sessions and no GH metadata — caller
 * emits a `{type:'delete', key}` op in that case.
 *
 * `userId` is accepted for symmetry with the broadcast call site and for
 * future per-user visibility filtering, but is currently unused: chains
 * are shared across users today (see /api/chains — no `user_id` filter
 * on the top-level read). Passing the argument keeps the call site
 * expressive and lets us add filtering without a signature change.
 */
export async function buildChainRow(
  env: Env,
  db: DrizzleDB,
  _userId: string,
  issueNumber: number,
): Promise<ChainSummary | null> {
  const sessionRows = await db
    .select({
      id: agentSessions.id,
      kataMode: agentSessions.kataMode,
      status: agentSessions.status,
      lastActivity: agentSessions.lastActivity,
      createdAt: agentSessions.createdAt,
      project: agentSessions.project,
    })
    .from(agentSessions)
    .where(eq(agentSessions.kataIssue, issueNumber))
    .orderBy(asc(agentSessions.createdAt))

  const reservationRows = await db
    .select()
    .from(worktreeReservations)
    .where(eq(worktreeReservations.issueNumber, issueNumber))
    .limit(1)
  const reservation = reservationRows[0] ?? null

  const ctx = await loadChainBuildContext(env)

  return buildChainRowFromContext(issueNumber, sessionRows, reservation, ctx)
}
