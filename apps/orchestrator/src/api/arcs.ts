/**
 * GH#116 P1.3: `/api/arcs` CRUD surface — replaces `/api/chains`.
 *
 * Arcs are the durable parent of every session (orchestrator-side
 * analog of a kata "chain", expanded to cover orphan / debug / freeform
 * sessions and explicit branch trees). The eight endpoints registered
 * here cover create / list / detail / patch (rename + status) plus the
 * three lifecycle primitives (`/sessions` advance, `/branch`, `/close`,
 * `/archive`).
 *
 * Mounted from `createApiApp()` after `app.use('/api/*',
 * authMiddleware)` so every handler reads `c.get('userId')` and
 * `c.get('role')` directly (no per-handler auth ceremony).
 *
 * Two of the routes dispatch into a SessionDO via @callable RPC:
 *   - `POST /api/arcs/:id/sessions` calls `advanceArc(args)` on the
 *     arc's frontier session DO when a non-terminal session exists; on
 *     a fresh / all-terminal arc it falls through to `createSession()`
 *     directly with `arcId` carried over.
 *   - `POST /api/arcs/:id/branch` calls `branchArc(args)` on the parent
 *     session's DO (resolved from `args.fromSessionId`).
 *
 * Status broadcasts go through `broadcastSyncedDelta` keyed on
 * `'arcs'` (matches the rename in `db/chains-collection.ts` →
 * `db/arcs-collection.ts` landing in parallel via the WS-rename agent).
 * No cross-user fanout — arcs are user-scoped per the schema's
 * `idx_arcs_user_status_lastactivity` index, so we only deliver the
 * delta to the arc's owner.
 */

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as schema from '~/db/schema'
import { agentSessions, arcMembers, arcs, worktrees } from '~/db/schema'
import {
  type ArcBuildContext,
  buildArcRow,
  buildArcRowFromContext,
  deriveColumn,
  formatExternalRef,
  parseExternalRef,
} from '~/lib/arcs'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { createSession } from '~/lib/create-session'
import type { ArcSummary, Env } from '~/lib/types'
import type { ApiAppEnv } from './context'

type Db = ReturnType<typeof drizzle<typeof schema>>

const ARC_ID_PREFIX = 'arc_'
const VALID_PROVIDERS = new Set(['github', 'linear', 'plain'])
// Statuses that mean "this session is the live frontier — advance via
// the DO RPC, don't mint fresh from the arc". Anything else (idle but
// only because the user closed it, error, completed) is treated as
// terminal for advance purposes.
const NON_TERMINAL_STATUSES = new Set(['idle', 'pending', 'running', 'starting'])

function getDb(env: ApiAppEnv['Bindings']): Db {
  return drizzle(env.AUTH_DB, { schema })
}

/** Mint a new arc id (mirrors `lib/create-session.ts:newArcId`). */
function newArcId(): string {
  return `${ARC_ID_PREFIX}${crypto.randomUUID()}`
}

/** Resolve a session id to its DO stub — hex ids use idFromString. */
function getSessionDoId(env: ApiAppEnv['Bindings'], sessionId: string) {
  const isHexId = /^[0-9a-f]{64}$/.test(sessionId)
  return isHexId
    ? env.SESSION_AGENT.idFromString(sessionId)
    : env.SESSION_AGENT.idFromName(sessionId)
}

/**
 * Validate an externalRef body shape. Accepts only the three known
 * providers and a string|number id. URL is optional. Returns null on
 * any failure so the caller can return 400.
 */
function validateExternalRef(
  value: unknown,
): { provider: 'github' | 'linear' | 'plain'; id: string | number; url?: string } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as { provider?: unknown; id?: unknown; url?: unknown }
  if (typeof v.provider !== 'string' || !VALID_PROVIDERS.has(v.provider)) return null
  if (typeof v.id !== 'string' && typeof v.id !== 'number') return null
  if (v.url !== undefined && typeof v.url !== 'string') return null
  const ref: { provider: 'github' | 'linear' | 'plain'; id: string | number; url?: string } = {
    provider: v.provider as 'github' | 'linear' | 'plain',
    id: v.id,
  }
  if (typeof v.url === 'string') ref.url = v.url
  return ref
}

/**
 * Fire-and-forget delta broadcast for a single arc. The fanout target
 * is the arc's owner only — arcs are user-scoped.
 *
 * Pass `op: 'delete'` only on hard-delete (not implemented in P1).
 * `op: 'update'` is treated as upsert by the synced-collection sync
 * path, so brand-new arcs land correctly without a separate `'insert'`.
 */
async function broadcastArcUpdate(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  userId: string,
  arcId: string,
): Promise<void> {
  const db = drizzle(env.AUTH_DB, { schema })
  const row = await buildArcRow(env, db, userId, arcId)
  if (!row) return
  const op = { type: 'update' as const, value: row } as const
  ctx.waitUntil(broadcastSyncedDelta(env, userId, 'arcs', [op]))
}

// ─── Body shapes ────────────────────────────────────────────────────────────

interface CreateArcBody {
  title?: unknown
  externalRef?: unknown
  parentArcId?: unknown
}

interface PatchArcBody {
  title?: unknown
  status?: unknown
}

interface AdvanceArcBody {
  mode?: unknown
  prompt?: unknown
  agent?: unknown
  project?: unknown
}

interface BranchArcBody {
  fromSessionId?: unknown
  fromMessageSeq?: unknown
  prompt?: unknown
  mode?: unknown
  title?: unknown
}

// ─── Router factory ─────────────────────────────────────────────────────────

export function arcsRoutes() {
  const app = new Hono<ApiAppEnv>()

  // ── POST /api/arcs ───────────────────────────────────────────────────────
  // Create a new arc. `externalRef` is optional; when present, the
  // unique partial index on `json_extract(external_ref, '$.id|$.provider')`
  // throws on a duplicate, which we catch and return as 409 with the
  // existing arcId. The arc starts in `'draft'` status because no
  // session has been spawned yet; `POST /api/arcs/:id/sessions` flips
  // it to `'open'` (via createSession's arc-resolution path) on first
  // spawn.
  app.post('/', async (c) => {
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => null)) as CreateArcBody | null
    if (!body) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return c.json({ error: 'missing_required_field', field: 'title' }, 400)
    }

    let externalRef: ReturnType<typeof validateExternalRef> = null
    if (body.externalRef !== undefined && body.externalRef !== null) {
      externalRef = validateExternalRef(body.externalRef)
      if (!externalRef) {
        return c.json({ error: 'invalid_external_ref' }, 400)
      }
    }

    let parentArcId: string | null = null
    if (body.parentArcId !== undefined && body.parentArcId !== null) {
      if (typeof body.parentArcId !== 'string' || body.parentArcId.length === 0) {
        return c.json({ error: 'invalid_parent_arc_id' }, 400)
      }
      parentArcId = body.parentArcId
    }

    const db = getDb(c.env)

    // Pre-check duplicate-externalRef so we can return the existing
    // arcId without parsing a SQLite UNIQUE-constraint error string.
    if (externalRef) {
      const existing = await db
        .select({ id: arcs.id })
        .from(arcs)
        .where(
          and(
            eq(arcs.userId, userId),
            sql`json_extract(${arcs.externalRef}, '$.provider') = ${externalRef.provider}`,
            sql`json_extract(${arcs.externalRef}, '$.id') = ${externalRef.id}`,
          ),
        )
        .limit(1)
      if (existing[0]?.id) {
        return c.json({ ok: false, existingArcId: existing[0].id }, 409)
      }
    }

    const id = newArcId()
    const now = new Date().toISOString()

    try {
      await db.insert(arcs).values({
        id,
        userId,
        title: body.title.trim(),
        externalRef: externalRef ? formatExternalRef(externalRef) : null,
        status: 'draft',
        parentArcId,
        createdAt: now,
        updatedAt: now,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Race between pre-check and INSERT — the unique index trips.
      if (/UNIQUE|constraint/i.test(msg) && externalRef) {
        const raced = await db
          .select({ id: arcs.id })
          .from(arcs)
          .where(
            and(
              eq(arcs.userId, userId),
              sql`json_extract(${arcs.externalRef}, '$.provider') = ${externalRef.provider}`,
              sql`json_extract(${arcs.externalRef}, '$.id') = ${externalRef.id}`,
            ),
          )
          .limit(1)
        if (raced[0]?.id) {
          return c.json({ ok: false, existingArcId: raced[0].id }, 409)
        }
      }
      throw err
    }

    await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, id)
    return c.json({ arcId: id }, 201)
  })

  // ── GET /api/arcs ────────────────────────────────────────────────────────
  // List arcs visible to the caller. Visibility (GH#152 P1) is a
  // membership-or-public model:
  //   - `lane=mine`   (default) → arcs the caller owns OR is a member
  //                                of (via `arc_members`).
  //   - `lane=public` → arcs with `visibility='public'` (discoverable
  //                     to all authed users, regardless of ownership).
  //   - `lane=all`    → union of `mine` + `public`.
  //
  // Other filters (preserved):
  //   - `provider` filters by `externalRef.provider` (was: legacy
  //                `lane`; renamed because `lane` now governs ACL).
  //   - `column`   filters by the kanban column derived from sessions.
  //   - `project`  filters to arcs that have at least one session in
  //                the named project.
  //   - `stale`    `{N}d` form — arcs whose lastActivity is older than N days.
  //   - `status`   comma-separated subset of {draft,open,closed,archived}
  //                or 'all'. Default: `draft,open` (the kanban board's
  //                in-flight set).
  //
  // `more_issues_available` is preserved from the chain shape as a
  // pagination-overflow hint; it's always `false` here because we
  // don't truncate the per-user arc list.
  const ALL_ARC_STATUSES = ['draft', 'open', 'closed', 'archived'] as const
  const DEFAULT_ARC_STATUSES = new Set<string>(['draft', 'open'])
  const VALID_LANES = new Set(['mine', 'public', 'all'])

  app.get('/', async (c) => {
    const userId = c.get('userId')
    const db = getDb(c.env)

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

    // GH#152 P1: `lane` now governs visibility/ACL filtering. Default
    // `mine` matches the legacy "your arcs" behaviour exactly (own +
    // member-of); `public` discovers shared arcs; `all` is the union.
    const laneParam = c.req.query('lane') ?? 'mine'
    if (!VALID_LANES.has(laneParam)) {
      return c.json(
        { error: 'Invalid lane — expected one of mine|public|all', invalid: laneParam },
        400,
      )
    }
    const lane = laneParam as 'mine' | 'public' | 'all'

    const providerFilter = c.req.query('provider')
    const columnFilter = c.req.query('column')
    const projectFilter = c.req.query('project')

    // Status filter: default `draft,open`; `all` opts in to closed/
    // archived too. Unknown tokens fail loudly so a typo doesn't
    // silently give the caller a different result set.
    const statusParam = c.req.query('status')
    let statusFilter: ReadonlySet<string> = DEFAULT_ARC_STATUSES
    if (typeof statusParam === 'string' && statusParam.length > 0) {
      if (statusParam === 'all') {
        statusFilter = new Set(ALL_ARC_STATUSES)
      } else {
        const parts = statusParam
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
        const invalid = parts.find((p) => !(ALL_ARC_STATUSES as readonly string[]).includes(p))
        if (invalid) {
          return c.json(
            {
              error: `Invalid status — expected subset of {${ALL_ARC_STATUSES.join(',')}} or 'all'`,
              invalid,
            },
            400,
          )
        }
        statusFilter = new Set(parts)
      }
    }

    // 1. Pull arcs matching the lane's ACL clause.
    //
    // - `mine`   → owner OR EXISTS arc_members(arc_id, user_id)
    // - `public` → visibility='public'
    // - `all`    → owner OR EXISTS member OR visibility='public'
    //
    // The EXISTS subquery is keyed on the `idx_arc_members_user`
    // (user_id, arc_id) index added in 0034 so it costs O(log N) per
    // arc row evaluation.
    const memberExists = sql`EXISTS (
      SELECT 1 FROM ${arcMembers}
      WHERE ${arcMembers.arcId} = ${arcs.id} AND ${arcMembers.userId} = ${userId}
    )`
    const aclWhere =
      lane === 'public'
        ? eq(arcs.visibility, 'public')
        : lane === 'mine'
          ? or(eq(arcs.userId, userId), memberExists)
          : or(eq(arcs.userId, userId), memberExists, eq(arcs.visibility, 'public'))

    const arcRows = await db.select().from(arcs).where(aclWhere)
    if (arcRows.length === 0) {
      return c.json({ arcs: [], more_issues_available: false })
    }

    const arcIds = arcRows.map((a) => a.id)

    // 2. Bulk-fetch all sessions for those arcs.
    const sessionRows = await db
      .select({
        id: agentSessions.id,
        arcId: agentSessions.arcId,
        mode: agentSessions.mode,
        status: agentSessions.status,
        lastActivity: agentSessions.lastActivity,
        createdAt: agentSessions.createdAt,
        project: agentSessions.project,
      })
      .from(agentSessions)
      .where(inArray(agentSessions.arcId, arcIds))
      .orderBy(asc(agentSessions.createdAt))

    const sessionsByArc = new Map<string, typeof sessionRows>()
    for (const s of sessionRows) {
      if (!s.arcId) continue
      const list = sessionsByArc.get(s.arcId) ?? []
      list.push(s)
      sessionsByArc.set(s.arcId, list)
    }

    // 3. Bulk-fetch reservations for arcs with a worktreeId.
    const worktreeIds = Array.from(
      new Set(arcRows.map((a) => a.worktreeId).filter((x): x is string => !!x)),
    )
    const wtRows = worktreeIds.length
      ? await db.select().from(worktrees).where(inArray(worktrees.id, worktreeIds))
      : []
    const wtById = new Map(wtRows.map((w) => [w.id, w]))

    // 3b. Bulk-fetch member counts (GH#152 P1). One GROUP BY query
    //     across the visible arc set; absent arc ids implicitly count 0.
    const memberCountRows = await db
      .select({
        arcId: arcMembers.arcId,
        count: sql<number>`count(*)`,
      })
      .from(arcMembers)
      .where(inArray(arcMembers.arcId, arcIds))
      .groupBy(arcMembers.arcId)
    const memberCountByArc = new Map<string, number>()
    for (const r of memberCountRows) {
      memberCountByArc.set(r.arcId, Number(r.count ?? 0))
    }

    // 4. Build ArcSummary[] via the shared mapping. P1.3 leaves
    //    `prNumberByExternalRef` empty — the GH PR cache plumb-through
    //    is deferred (P3 will wire it).
    const buildCtx: ArcBuildContext = { prNumberByExternalRef: new Map() }
    const out: ArcSummary[] = []
    for (const arcRow of arcRows) {
      const sessions = sessionsByArc.get(arcRow.id) ?? []
      const reservation = arcRow.worktreeId ? (wtById.get(arcRow.worktreeId) ?? null) : null
      const memberCount = memberCountByArc.get(arcRow.id) ?? 0
      const arc = buildArcRowFromContext(arcRow, sessions, reservation, buildCtx, memberCount)

      // Filter pass — applied to the projected ArcSummary so the column
      // filter sees the same value the client renders.
      if (!statusFilter.has(arc.status)) continue
      if (providerFilter) {
        const provider = arc.externalRef?.provider ?? null
        if (provider !== providerFilter) continue
      }
      if (columnFilter) {
        const column = deriveColumn(arc.sessions, arc.status)
        if (column !== columnFilter) continue
      }
      if (projectFilter) {
        const hasProject = sessions.some((s) => s.project === projectFilter)
        if (!hasProject) continue
      }
      if (staleCutoff !== null) {
        const ts = arc.lastActivity ? new Date(arc.lastActivity).getTime() : -Infinity
        if (!Number.isFinite(ts) || ts >= staleCutoff) continue
      }

      out.push(arc)
    }

    // Sort by lastActivity DESC; arcs with no sessions sink to bottom.
    out.sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : -Infinity
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : -Infinity
      return tb - ta
    })

    return c.json({ arcs: out, more_issues_available: false })
  })

  // ── GET /api/arcs/:id ────────────────────────────────────────────────────
  app.get('/:id', async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const db = getDb(c.env)
    const arc = await buildArcRow(c.env as unknown as Env, db, userId, id)
    if (!arc) return c.json({ error: 'not_found' }, 404)
    return c.json({ arc })
  })

  // ── PATCH /api/arcs/:id ──────────────────────────────────────────────────
  // Body `{title?, status?}`; at least one field required (400 if
  // empty body or no recognised keys). Status transitions allowed
  // here: `'open' | 'archived'` — `'closed'` is rejected so callers
  // route through `POST /api/arcs/:id/close` (which also stamps
  // `closed_at`). `'draft'` is rejected because draft → open is the
  // implicit transition triggered by spawning the first session.
  app.patch('/:id', async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as PatchArcBody | null
    if (!body) {
      return c.json({ error: 'invalid_body' }, 400)
    }

    const updates: Partial<typeof arcs.$inferInsert> = {}

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        return c.json({ error: 'invalid_title' }, 400)
      }
      updates.title = body.title.trim()
    }

    if (body.status !== undefined) {
      if (body.status !== 'open' && body.status !== 'archived') {
        // 'closed' routes through POST /:id/close (so closed_at is
        // stamped); 'draft' is implicit-only.
        return c.json({ error: 'invalid_status' }, 400)
      }
      updates.status = body.status
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'no_recognised_fields' }, 400)
    }

    updates.updatedAt = new Date().toISOString()

    const db = getDb(c.env)
    const result = await db
      .update(arcs)
      .set(updates)
      .where(and(eq(arcs.id, id), eq(arcs.userId, userId)))
      .returning({ id: arcs.id })
    if (result.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    const arc = await buildArcRow(c.env as unknown as Env, db, userId, id)
    if (!arc) return c.json({ error: 'not_found' }, 404)
    await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, id)
    return c.json({ arc })
  })

  // ── POST /api/arcs/:id/sessions (advanceArc) ─────────────────────────────
  // Body `{mode?, prompt, agent?}`.
  //   - Empty arc OR all-terminal → mint a fresh session via
  //     `createSession()` with `arcId` carried over.
  //   - Otherwise → pick the latest non-terminal session and dispatch
  //     into its DO via the `advanceArc` @callable RPC, which closes
  //     the frontier and mints a successor with `parentSessionId`
  //     pointing at the closing session.
  // The partial unique index `idx_agent_sessions_arc_mode_active`
  // catches duplicate-successor races at insert time; we surface that
  // as 409 `{ok:false, existingSessionId}`.
  app.post('/:id/sessions', async (c) => {
    const userId = c.get('userId')
    const arcId = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as AdvanceArcBody | null
    if (!body) return c.json({ error: 'invalid_body' }, 400)
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return c.json({ error: 'missing_required_field', field: 'prompt' }, 400)
    }
    const mode =
      body.mode === undefined || body.mode === null
        ? null
        : typeof body.mode === 'string'
          ? body.mode
          : null
    const agent = typeof body.agent === 'string' ? body.agent : undefined

    const db = getDb(c.env)
    const arcRows = await db
      .select()
      .from(arcs)
      .where(and(eq(arcs.id, arcId), eq(arcs.userId, userId)))
      .limit(1)
    if (arcRows.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    // Find the latest non-terminal session in this arc. The frontier
    // is determined by max(createdAt) among non-terminal sessions; if
    // none, the arc is fresh / fully terminal and we mint directly.
    const sessions = await db
      .select({
        id: agentSessions.id,
        status: agentSessions.status,
        project: agentSessions.project,
        createdAt: agentSessions.createdAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.arcId, arcId))
      .orderBy(desc(agentSessions.createdAt))

    const frontier = sessions.find((s) => NON_TERMINAL_STATUSES.has(s.status))

    try {
      if (!frontier) {
        // Mint directly — backlog-bootstrap callers (arcs with no
        // sessions yet) pass `body.project` to seed the worktree;
        // otherwise we inherit from the latest prior session. 400
        // remains for the genuinely-empty case (no body.project AND
        // no prior session to inherit from).
        const bodyProject =
          typeof body.project === 'string' && body.project.length > 0 ? body.project : null
        const project = bodyProject ?? sessions[0]?.project ?? ''
        if (!project) {
          return c.json({ error: 'no_project_for_arc' }, 400)
        }
        const result = await createSession(
          c.env as unknown as Env,
          userId,
          {
            project,
            arcId,
            prompt: body.prompt,
            mode,
            agent,
          },
          c.executionCtx,
        )
        if (!result.ok) {
          return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 500 | 503)
        }
        await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, arcId)
        return c.json({ sessionId: result.sessionId, arcId: result.arcId }, 201)
      }

      // Dispatch into the frontier session's DO.
      const doId = getSessionDoId(c.env, frontier.id)
      const stub = c.env.SESSION_AGENT.get(doId)
      const rpcResult = await (
        stub as unknown as {
          advanceArc: (args: {
            mode?: string | null
            prompt: string
            agent?: string
          }) => Promise<{ ok: boolean; sessionId?: string; arcId?: string; error?: string }>
        }
      ).advanceArc({ mode, prompt: body.prompt, agent })

      if (!rpcResult.ok || !rpcResult.sessionId || !rpcResult.arcId) {
        return c.json({ error: rpcResult.error ?? 'advance_failed' }, 500)
      }
      await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, arcId)
      return c.json({ sessionId: rpcResult.sessionId, arcId: rpcResult.arcId }, 201)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Partial-unique idempotency race: surface the in-flight successor
      // so the client can re-route to the existing session.
      //
      // The recovery is only meaningful when `mode != null`. The partial
      // unique index `idx_agent_sessions_arc_mode_active` carries
      // `AND mode IS NOT NULL` (see schema.ts / migration 0032 step 16),
      // so a null-mode insert can never trigger that index. Any
      // UNIQUE-shaped error encountered here with `mode == null` must
      // be from some other constraint (e.g. PK collision) and should
      // surface as-is rather than being misclassified as an advance
      // idempotency conflict.
      if (/UNIQUE|constraint/i.test(msg) && mode != null) {
        const existing = await db
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.arcId, arcId),
              eq(agentSessions.mode, mode),
              inArray(agentSessions.status, ['idle', 'pending', 'running']),
            ),
          )
          .limit(1)
        if (existing[0]?.id) {
          return c.json({ ok: false, existingSessionId: existing[0].id }, 409)
        }
        return c.json({ ok: false, error: 'idempotency_conflict' }, 409)
      }
      throw err
    }
  })

  // ── POST /api/arcs/:id/branch (branchArc) ────────────────────────────────
  // Body `{fromSessionId, fromMessageSeq?, prompt, mode?, title?}`.
  // `:id` is the parent arc; `fromSessionId` identifies which session
  // inside that arc supplies the transcript prefix. The DO RPC
  // `branchArc` builds the wrapped prompt and creates the child arc +
  // first session.
  app.post('/:id/branch', async (c) => {
    const userId = c.get('userId')
    const parentArcId = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as BranchArcBody | null
    if (!body) return c.json({ error: 'invalid_body' }, 400)

    if (typeof body.fromSessionId !== 'string' || body.fromSessionId.length === 0) {
      return c.json({ error: 'missing_required_field', field: 'fromSessionId' }, 400)
    }
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      return c.json({ error: 'missing_required_field', field: 'prompt' }, 400)
    }
    let fromMessageSeq: number | undefined
    if (body.fromMessageSeq !== undefined && body.fromMessageSeq !== null) {
      if (
        typeof body.fromMessageSeq !== 'number' ||
        !Number.isInteger(body.fromMessageSeq) ||
        body.fromMessageSeq < 0
      ) {
        return c.json({ error: 'invalid_from_message_seq' }, 400)
      }
      fromMessageSeq = body.fromMessageSeq
    }
    const mode =
      body.mode === undefined || body.mode === null
        ? null
        : typeof body.mode === 'string'
          ? body.mode
          : null
    const title = typeof body.title === 'string' ? body.title : undefined

    const db = getDb(c.env)

    // Verify the parent arc exists and is owned by the caller.
    const parentArcRow = await db
      .select({ id: arcs.id })
      .from(arcs)
      .where(and(eq(arcs.id, parentArcId), eq(arcs.userId, userId)))
      .limit(1)
    if (parentArcRow.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    // Verify the parent session belongs to this arc + user.
    const sessionRow = await db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, body.fromSessionId),
          eq(agentSessions.arcId, parentArcId),
          eq(agentSessions.userId, userId),
        ),
      )
      .limit(1)
    if (sessionRow.length === 0) {
      return c.json({ error: 'session_not_in_arc' }, 404)
    }

    const doId = getSessionDoId(c.env, body.fromSessionId)
    const stub = c.env.SESSION_AGENT.get(doId)
    const rpcResult = await (
      stub as unknown as {
        branchArc: (args: {
          fromMessageSeq?: number
          prompt: string
          mode?: string | null
          title?: string
        }) => Promise<{
          ok: boolean
          newArcId?: string
          newSessionId?: string
          error?: string
        }>
      }
    ).branchArc({
      ...(fromMessageSeq !== undefined ? { fromMessageSeq } : {}),
      prompt: body.prompt,
      mode,
      ...(title !== undefined ? { title } : {}),
    })

    if (!rpcResult.ok || !rpcResult.newArcId || !rpcResult.newSessionId) {
      const errMsg = rpcResult.error ?? 'branch_failed'
      // Map the validation errors `branchArcImpl` returns to 400 so the
      // client can distinguish bad input from server failure.
      if (/invalid fromMessageSeq|prompt required/.test(errMsg)) {
        return c.json({ error: errMsg }, 400)
      }
      return c.json({ error: errMsg }, 500)
    }

    // Broadcast both arcs so the sidebar / kanban repaint immediately:
    // parent gains a child arc reference; child arc is brand new.
    await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, parentArcId)
    await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, rpcResult.newArcId)

    return c.json({ newArcId: rpcResult.newArcId, newSessionId: rpcResult.newSessionId }, 201)
  })

  // ── POST /api/arcs/:id/close ────────────────────────────────────────────
  // Sets status='closed' + stamps closed_at. Idempotent on a
  // re-close (status is overwritten, closed_at is bumped to now).
  app.post('/:id/close', async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const db = getDb(c.env)
    const now = new Date().toISOString()

    const result = await db
      .update(arcs)
      .set({ status: 'closed', closedAt: now, updatedAt: now })
      .where(and(eq(arcs.id, id), eq(arcs.userId, userId)))
      .returning({ id: arcs.id })
    if (result.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    const arc = await buildArcRow(c.env as unknown as Env, db, userId, id)
    if (!arc) return c.json({ error: 'not_found' }, 404)
    await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, id)
    return c.json({ arc })
  })

  // ── POST /api/arcs/:id/archive ──────────────────────────────────────────
  app.post('/:id/archive', async (c) => {
    const userId = c.get('userId')
    const id = c.req.param('id')
    const db = getDb(c.env)
    const now = new Date().toISOString()

    const result = await db
      .update(arcs)
      .set({ status: 'archived', updatedAt: now })
      .where(and(eq(arcs.id, id), eq(arcs.userId, userId)))
      .returning({ id: arcs.id })
    if (result.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    const arc = await buildArcRow(c.env as unknown as Env, db, userId, id)
    if (!arc) return c.json({ error: 'not_found' }, 404)
    await broadcastArcUpdate(c.env as unknown as Env, c.executionCtx, userId, id)
    return c.json({ arc })
  })

  return app
}

// Re-export for convenience — the parseExternalRef helper is sometimes
// useful at the API layer too, though unused here directly.
void parseExternalRef
