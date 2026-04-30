/**
 * Arc aggregation helpers (GH#116).
 *
 * Arcs are the durable parent of every session (orchestrator-side
 * analog of a kata "chain", expanded to cover orphan / debug /
 * freeform / branch trees).
 *
 * `buildArcRow(env, db, userId, arcId)` returns the current ArcSummary
 * for a single arc or `null` if the arc isn't found. The pure
 * `buildArcRowFromContext` variant exists so the /api/arcs batch
 * handler can pre-fetch sessions + reservations and project rows
 * field-by-field without re-querying.
 *
 * GitHub PR resolution is deferred to the caller via
 * `ArcBuildContext.prNumberByExternalRef` (the API route's GH cache
 * threads through this); `buildArcRow` itself stubs `prNumber` as
 * `undefined`.
 *
 * P5 (this commit) deleted `lib/chains.ts`; the small predicate
 * `isArcSessionCompleted` (formerly `isChainSessionCompleted`) lives
 * here now.
 */

import { and, asc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { agentSessions, arcs, worktrees } from '~/db/schema'
import type { ArcSummary, Env } from '~/lib/types'

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>

// ─── External ref helpers ────────────────────────────────────────────────────

export type ExternalRef = {
  provider: 'github' | 'linear' | 'plain'
  id: number | string
  url?: string
}

const VALID_PROVIDERS = new Set<ExternalRef['provider']>(['github', 'linear', 'plain'])

/**
 * Parse the `arcs.external_ref` JSON column. Returns null on:
 *   - `json` is null (column is unset)
 *   - parse failure (malformed JSON)
 *   - shape failure (provider not in the allowed set, or id not
 *     number/string)
 *
 * Never throws — round-trips with `formatExternalRef`.
 */
export function parseExternalRef(json: string | null): ExternalRef | null {
  if (json == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { provider?: unknown; id?: unknown; url?: unknown }
  if (typeof obj.provider !== 'string') return null
  if (!VALID_PROVIDERS.has(obj.provider as ExternalRef['provider'])) return null
  if (typeof obj.id !== 'string' && typeof obj.id !== 'number') return null
  const ref: ExternalRef = {
    provider: obj.provider as ExternalRef['provider'],
    id: obj.id,
  }
  if (typeof obj.url === 'string') ref.url = obj.url
  return ref
}

/** Stringify for storage in the `arcs.external_ref` text column. */
export function formatExternalRef(ref: ExternalRef): string {
  return JSON.stringify(ref)
}

// ─── Session liveness predicates ────────────────────────────────────────────

/**
 * Status values that mean "this session is actively doing work right
 * now" — i.e. the runner is engaged or expected to engage imminently.
 *
 * Excludes `'idle'` (ambiguous — covers both freshly-spawned and
 * parked-terminal; use `isArcSessionCompleted` to disambiguate) and
 * `'error'` (terminal failure). Mirrors the SessionStatus union in
 * packages/shared-types/src/index.ts.
 *
 * Used by `deriveColumn` (live session beats time-keyed) and by the
 * KanbanCard focus picker (live session beats stale terminals).
 */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'pending',
  'waiting_input',
  'waiting_permission',
  'waiting_gate',
  'waiting_identity',
  'failover',
])

/** True when the session's status is in `LIVE_STATUSES`. */
export function isLiveSession(session: { status: string }): boolean {
  return LIVE_STATUSES.has(session.status)
}

// ─── Session completion predicate (formerly isChainSessionCompleted) ────────

/**
 * Predicate: has this arc's session finished at least one turn and
 * parked as the terminal state for its rung?
 *
 * `agent_sessions.status` never holds `'completed'` in this codebase —
 * the `SessionStatus` union (packages/shared-types) is
 * `'idle' | 'pending' | 'running' | 'waiting_*' | 'error'`. Finished
 * sessions park as `'idle'`. `lastActivity != null` means at least one
 * turn ran (we don't treat a freshly-spawned `'pending'` row as
 * completed).
 *
 * Shared between:
 *   - use-arc-preconditions (client manual-advance gate)
 *   - KanbanCard status label rendering
 *   - ArcStatusItem rung-completed bit
 *
 * Renamed from `isChainSessionCompleted` in GH#116 P5.
 */
export function isArcSessionCompleted(session: {
  status: string
  lastActivity: string | null
}): boolean {
  return session.status === 'idle' && session.lastActivity != null
}

// ─── Kanban column derivation ────────────────────────────────────────────────

/**
 * Modes that qualify a session as a "frontier" for kanban column
 * placement. Non-qualifying modes (e.g. `debug`, `freeform`) are
 * skipped — an arc whose only sessions are debug sessions still
 * surfaces as `'backlog'` until a real workflow session arrives.
 *
 * Replaces the equivalent `COLUMN_QUALIFYING_MODES` set that lived
 * in `lib/chains.ts` (deleted in P5).
 *
 * Note: `'task'` (legacy implementation alias) is intentionally NOT
 * here — post-#116, sessions write the canonical `'implementation'`
 * mode directly. `'close'` IS here — it qualifies and special-cases
 * to `'done'` in `deriveColumn`.
 */
export const COLUMN_QUALIFYING_MODES: ReadonlySet<string> = new Set([
  'research',
  'planning',
  'implementation',
  'verify',
  'close',
])

export type KanbanColumn =
  | 'backlog'
  | 'research'
  | 'planning'
  | 'implementation'
  | 'verify'
  | 'done'

/**
 * Place an arc on the kanban board.
 *
 * - `arcStatus === 'draft'` → `'backlog'` (regardless of session
 *   contents — drafts don't appear on the board)
 * - empty sessions → `'backlog'`
 * - else: pick the frontier session by liveness-then-time:
 *   1. If any qualifying-mode session is live (status in
 *      `LIVE_STATUSES`), pick the most-recently-spawned one. This
 *      avoids the race where `verify` spawns moments after
 *      `implementation` parks-as-idle, and the impl's `lastActivity`
 *      being newer than verify's `createdAt` would otherwise pin the
 *      column on `'implementation'` even though verify is the work
 *      actually running.
 *   2. Otherwise pick the latest qualifying session by
 *      `lastActivity ?? createdAt` (the original heuristic).
 *   Special-case: `'close'` → `'done'`. No qualifying session →
 *   `'backlog'`.
 *
 * Reads `mode` (not the dropped `kataMode`) and is keyed on arc
 * status (not GH issue state). Closed/archived arcs are filtered at
 * the API layer (see `GET /api/arcs`); this function still maps them
 * deterministically when they're surfaced (e.g. by an opt-in
 * `?status=closed` query).
 */
export function deriveColumn(
  sessions: Array<{
    mode: string | null
    status: string
    lastActivity: string | null
    createdAt: string
  }>,
  arcStatus: 'draft' | 'open' | 'closed' | 'archived',
): KanbanColumn {
  if (arcStatus === 'draft') return 'backlog'
  if (!sessions.length) return 'backlog'

  // Pass 1 — live qualifying session wins, picked by createdAt
  // (most-recently-spawned). lastActivity isn't reliable for live
  // sessions: a brand-new `running` row may not have one yet.
  let liveMode: string | null = null
  let liveTs = -Infinity
  for (const s of sessions) {
    if (!s.mode || !COLUMN_QUALIFYING_MODES.has(s.mode)) continue
    if (!isLiveSession(s)) continue
    const ts = new Date(s.createdAt).getTime()
    if (Number.isFinite(ts) && ts > liveTs) {
      liveTs = ts
      liveMode = s.mode
    }
  }

  // Pass 2 — fall back to the latest qualifying session by activity
  // (matches the pre-cleanup behaviour for arcs with no live session).
  let bestMode: string | null = liveMode
  if (bestMode === null) {
    let bestTs = -Infinity
    for (const s of sessions) {
      if (!s.mode || !COLUMN_QUALIFYING_MODES.has(s.mode)) continue
      const ts = new Date(s.lastActivity ?? s.createdAt).getTime()
      if (Number.isFinite(ts) && ts > bestTs) {
        bestTs = ts
        bestMode = s.mode
      }
    }
  }

  if (bestMode === 'close') return 'done'
  if (bestMode === 'research') return 'research'
  if (bestMode === 'planning') return 'planning'
  if (bestMode === 'implementation') return 'implementation'
  if (bestMode === 'verify') return 'verify'
  return 'backlog'
}

// ─── Arc row builders ────────────────────────────────────────────────────────

/**
 * Pre-fetched context for batch callers (the /api/arcs handler).
 * The single-arc broadcaster uses an empty map; the API handler wires
 * the GH PR cache through this map so list builds get a `prNumber`
 * without re-fetching the GH list endpoints per-row.
 */
export interface ArcBuildContext {
  /** Map keyed by `${provider}:${id}` for cheap lookup. */
  prNumberByExternalRef: Map<string, number>
}

/** Number of ms after which a held worktree is considered "stale" for
 *  the kanban force-release UI gate. The constant lives here so arc
 *  projections compute the boolean without reaching across modules. */
const ARC_RESERVATION_STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Drizzle-inferred row shapes for the inputs of `buildArcRowFromContext`. */
type ArcRow = typeof arcs.$inferSelect
type SessionRow = typeof agentSessions.$inferSelect
type WorktreeRow = typeof worktrees.$inferSelect

/**
 * Pure mapping — builds the ArcSummary row given a pre-fetched arc
 * row, its session list, an optional worktree reservation row, and the
 * shared context.
 *
 * Field-by-field carryover:
 *   - id          ← arc.id              (was: issueNumber)
 *   - title       ← arc.title           (was: issueTitle from GH cache)
 *   - externalRef ← parseExternalRef(arc.externalRef)  (NEW)
 *   - status      ← arc.status          (was: derived from issueState)
 *   - worktreeId  ← arc.worktreeId      (NEW; explicit FK)
 *   - parentArcId ← arc.parentArcId     (NEW; for branch trees)
 *   - sessions    ← session rows projected onto {id,mode,status,lastActivity,createdAt}
 *   - column      ← deriveColumn(sessions, arc.status) — NOTE: ArcSummary
 *                   does not carry `column` directly (kanban column is
 *                   derived client-side from sessions+status); shape mirrors
 *                   what the spec defines verbatim, no `column` field.
 *   - worktreeReservation ← projected onto {worktree, heldSince,
 *                   lastActivityAt, ownerId, stale} when a worktree
 *                   row is supplied
 *   - prNumber    ← ctx.prNumberByExternalRef.get(`${provider}:${id}`)
 *                   when externalRef is present
 *   - lastActivity← max(session.lastActivity ?? session.createdAt) or
 *                   null when arc has no sessions
 */
export function buildArcRowFromContext(
  arcRow: ArcRow,
  sessionRows: Array<Pick<SessionRow, 'id' | 'mode' | 'status' | 'lastActivity' | 'createdAt'>>,
  reservation: WorktreeRow | null,
  ctx: ArcBuildContext,
): ArcSummary {
  const externalRef = parseExternalRef(arcRow.externalRef ?? null)

  const sessions = sessionRows.map((s) => ({
    id: s.id,
    mode: s.mode,
    status: s.status,
    lastActivity: s.lastActivity,
    createdAt: s.createdAt,
  }))

  // Latest activity across the arc's sessions; null when the arc has
  // no sessions yet (newly-created draft arc with no spawn).
  let lastActivity: string | null = null
  let lastActivityTs = -Infinity
  for (const s of sessions) {
    const tsStr = s.lastActivity ?? s.createdAt
    const ts = new Date(tsStr).getTime()
    if (Number.isFinite(ts) && ts > lastActivityTs) {
      lastActivityTs = ts
      lastActivity = tsStr
    }
  }

  // Project the worktrees row onto the wire shape ArcSummary exposes:
  // `{worktree, heldSince, lastActivityAt, ownerId, stale}` —
  // `worktree` is the path (UI label), `heldSince` is the
  // ISO-formatted createdAt (integer epoch → ISO), `lastActivityAt`
  // is the ISO-formatted lastTouchedAt, and `stale` is the 7d boolean.
  let worktreeReservation: ArcSummary['worktreeReservation']
  if (reservation) {
    worktreeReservation = {
      worktree: reservation.path,
      heldSince: new Date(reservation.createdAt).toISOString(),
      lastActivityAt: new Date(reservation.lastTouchedAt).toISOString(),
      ownerId: reservation.ownerId,
      stale: Date.now() - reservation.lastTouchedAt > ARC_RESERVATION_STALE_MS,
    }
  }

  // PR resolution: ctx-supplied. Single-arc callers pass an empty map
  // and `prNumber` stays undefined; the /api/arcs API handler hydrates
  // the map from the GH PR cache.
  let prNumber: number | undefined
  if (externalRef) {
    const key = `${externalRef.provider}:${externalRef.id}`
    prNumber = ctx.prNumberByExternalRef.get(key)
  }

  const arc: ArcSummary = {
    id: arcRow.id,
    title: arcRow.title,
    externalRef,
    status: arcRow.status as ArcSummary['status'],
    ...(arcRow.worktreeId ? { worktreeId: arcRow.worktreeId } : {}),
    ...(arcRow.parentArcId ? { parentArcId: arcRow.parentArcId } : {}),
    createdAt: arcRow.createdAt,
    updatedAt: arcRow.updatedAt,
    ...(arcRow.closedAt ? { closedAt: arcRow.closedAt } : {}),
    sessions,
    ...(worktreeReservation ? { worktreeReservation } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    lastActivity,
  }
  return arc
}

/**
 * Single-row builder for broadcast / single-arc callers. Fetches the
 * arc row, its sessions, and (when present) the FK'd worktrees row,
 * then delegates to `buildArcRowFromContext` with an empty context
 * map. The /api/arcs route handler uses a context-aware variant once
 * the GH PR cache is plumbed through.
 *
 * Returns `null` when the arc isn't found OR doesn't belong to the
 * given user. (Other-user arcs are not surfaced — arcs are
 * user-scoped per the schema's `idx_arcs_user_status_lastactivity`
 * index.)
 */
export async function buildArcRow(
  env: Env,
  db: DrizzleDB,
  userId: string,
  arcId: string,
): Promise<ArcSummary | null> {
  void env

  const arcRows = await db
    .select()
    .from(arcs)
    .where(and(eq(arcs.id, arcId), eq(arcs.userId, userId)))
    .limit(1)
  const arcRow = arcRows[0]
  if (!arcRow) return null

  const sessionRows = await db
    .select({
      id: agentSessions.id,
      mode: agentSessions.mode,
      status: agentSessions.status,
      lastActivity: agentSessions.lastActivity,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(eq(agentSessions.arcId, arcId))
    .orderBy(asc(agentSessions.createdAt))

  let reservation: WorktreeRow | null = null
  if (arcRow.worktreeId) {
    const wtRows = await db
      .select()
      .from(worktrees)
      .where(eq(worktrees.id, arcRow.worktreeId))
      .limit(1)
    reservation = wtRows[0] ?? null
  }

  // Empty context — the /api/arcs API handler passes a populated map.
  // Single-arc broadcasts ship without a PR badge; the kanban list view
  // populates it from its batched GH cache.
  const ctx: ArcBuildContext = { prNumberByExternalRef: new Map() }

  return buildArcRowFromContext(arcRow, sessionRows, reservation, ctx)
}
