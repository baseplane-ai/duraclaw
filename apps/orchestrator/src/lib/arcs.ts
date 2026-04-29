/**
 * Arc aggregation helpers (GH#116 P1).
 *
 * The forward-looking replacement for `lib/chains.ts`: arcs are the
 * durable parent of every session (orchestrator-side analog of a kata
 * "chain", expanded to cover orphan / debug / freeform / branch trees).
 *
 * `buildArcRow(env, db, userId, arcId)` returns the current ArcSummary
 * for a single arc or `null` if the arc isn't found. The pure
 * `buildArcRowFromContext` variant exists so the future /api/arcs
 * batch handler can pre-fetch sessions + reservations and project rows
 * field-by-field without re-querying.
 *
 * For P1, GitHub PR resolution is intentionally deferred to the caller
 * via `ArcBuildContext.prNumberByExternalRef` (P3 wires the API
 * route's GH cache through this); `buildArcRow` itself stubs `prNumber`
 * as `undefined`.
 *
 * `lib/chains.ts` continues to live alongside this file until P5
 * deletes it (per spec §P1).
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

// ─── Kanban column derivation (replaces lib/chains.ts deriveColumn) ──────────

/**
 * Modes that qualify a session as a "frontier" for kanban column
 * placement. Non-qualifying modes (e.g. `debug`, `freeform`) are
 * skipped — an arc whose only sessions are debug sessions still
 * surfaces as `'backlog'` until a real workflow session arrives.
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
 * - else: pick the latest session whose `mode` is in
 *   `COLUMN_QUALIFYING_MODES` (by `lastActivity ?? createdAt`) and
 *   return that mode, special-casing `'close'` → `'done'`. If no
 *   session qualifies, fall through to `'backlog'`.
 *
 * Mirrors the algorithm in `lib/chains.ts:168-191` but reads `mode`
 * (not the dropped `kataMode`) and is keyed on arc status (not GH
 * issue state). Closed/archived arcs still go through the qualifying
 * scan — the spec leaves "what column does a closed arc sit in?" to
 * the API layer (which can opt to filter them off the board entirely).
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

  let bestMode: string | null = null
  let bestTs = -Infinity
  for (const s of sessions) {
    if (!s.mode || !COLUMN_QUALIFYING_MODES.has(s.mode)) continue
    const ts = new Date(s.lastActivity ?? s.createdAt).getTime()
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts
      bestMode = s.mode
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
 * Pre-fetched context for batch callers (the future /api/arcs handler).
 * P1 leaves `prNumberByExternalRef` empty — P3 wires the GH PR cache
 * through this map so single-row builds get a `prNumber` without
 * re-fetching the GH list endpoints.
 */
export interface ArcBuildContext {
  /** Map keyed by `${provider}:${id}` for cheap lookup. */
  prNumberByExternalRef: Map<string, number>
}

/** Number of ms after which a held worktree is considered "stale" for
 *  the kanban force-release UI gate. Mirrors `CHAIN_RESERVATION_STALE_MS`
 *  in `lib/chains.ts` — the constant lives here too so arc projections
 *  compute the boolean without reaching across modules. */
const ARC_RESERVATION_STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Drizzle-inferred row shapes for the inputs of `buildArcRowFromContext`. */
type ArcRow = typeof arcs.$inferSelect
type SessionRow = typeof agentSessions.$inferSelect
type WorktreeRow = typeof worktrees.$inferSelect

/**
 * Pure mapping — builds the ArcSummary row given a pre-fetched arc
 * row, its session list, an optional worktree reservation row, and the
 * shared context. Mirrors `buildChainRowFromContext` from
 * `lib/chains.ts` but mapped onto the post-#116 ArcSummary shape.
 *
 * Field-by-field carryover:
 *   - id          ← arc.id              (was: issueNumber)
 *   - title       ← arc.title           (was: issueTitle from GH cache)
 *   - externalRef ← parseExternalRef(arc.externalRef)  (NEW)
 *   - status      ← arc.status          (was: derived from issueState)
 *   - worktreeId  ← arc.worktreeId      (NEW; explicit FK)
 *   - parentArcId ← arc.parentArcId     (NEW; for branch trees)
 *   - sessions    ← session rows projected onto {id,mode,status,lastActivity,createdAt}
 *   - column      ← deriveColumn(sessions, arc.status)  — NOTE: ArcSummary
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

  // Project the worktrees row onto the wire shape ArcSummary exposes.
  // Differs from ChainWorktreeReservation: ArcSummary's reservation
  // surface is `{worktree, heldSince, lastActivityAt, ownerId, stale}`
  // — `worktree` is the path (UI label), `heldSince` is the
  // ISO-formatted createdAt (integer epoch → ISO), `lastActivityAt`
  // is the ISO-formatted lastTouchedAt, and `stale` is the legacy 7d
  // boolean.
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

  // PR resolution: ctx-supplied. P1 callers pass an empty map and
  // `prNumber` stays undefined; P3's API handler hydrates the map from
  // the GH PR cache (mirroring `findPrForIssue` in lib/chains.ts).
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
 * map. P3 will replace this with a context-aware variant once the GH
 * PR cache is plumbed through the API route handler.
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

  // Empty context — P3's API handler will pass a populated map. Until
  // then, single-arc broadcasts ship without a PR badge, which is
  // acceptable for the wave-2 milestone (the chain path still resolves
  // PR numbers via the legacy /api/chains route).
  const ctx: ArcBuildContext = { prNumberByExternalRef: new Map() }

  return buildArcRowFromContext(arcRow, sessionRows, reservation, ctx)
}
