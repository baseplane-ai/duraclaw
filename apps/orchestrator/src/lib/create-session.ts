/**
 * Session-creation helper — extracted from `POST /api/sessions` so the
 * auto-advance path (`tryAutoAdvance` in ~/lib/auto-advance) can spawn a
 * successor without round-tripping through the same-worker REST endpoint.
 *
 * Mirrors the REST handler's behavior exactly:
 *   - resolves the project path via the gateway's /projects listing;
 *   - creates (or rebinds) the SessionDO via idFromName / newUniqueId;
 *   - posts /create on the DO to hydrate its SessionMeta;
 *   - inserts / upserts the D1 `agent_sessions` row;
 *   - broadcasts the row via `broadcastSessionRow` (wrapped in waitUntil).
 */

import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { ReservedBy, SessionWorktreeParam } from '~/api/worktrees-types'
import * as schema from '~/db/schema'
import { agentSessions, arcs } from '~/db/schema'
import { broadcastChainRow } from '~/lib/broadcast-arc'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import { resolveProjectPath } from '~/lib/gateway-files'
import { promptToPreviewText } from '~/lib/prompt-preview'
import { bindWorktreeById, reserveFreshWorktree } from '~/lib/reserve-worktree'
import type { ContentBlock, Env } from '~/lib/types'

// Match the REST handler's regex for client-supplied session IDs.
const CLIENT_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

export interface CreateSessionParams {
  project: string
  /**
   * Optional initial prompt. When omitted, the DO is initialised in `idle`
   * with no runner — the gateway dial is deferred to the first sendMessage
   * (the deferred-runner flow used by "new session" tab clicks). When
   * present, the runner spawns immediately as before.
   */
  prompt?: string | ContentBlock[]
  model?: string
  system_prompt?: string
  runner_session_id?: string
  agent?: string
  /**
   * GH#116: explicit arc parent. When provided, the new session is
   * inserted with this `arcId`. When absent, an arc is resolved or
   * auto-created (see B4 in spec 116) — `kataIssue` (transitional)
   * looks up / creates an arc with `externalRef={provider:'github',id}`,
   * otherwise an implicit draft arc is created with the prompt preview
   * as its title.
   */
  arcId?: string
  /**
   * Transitional: legacy callers still pass `kataIssue`. Resolved into
   * an arc lookup-or-create at session-create time. Removed in P5.
   */
  kataIssue?: number | null
  /**
   * GH#116: the kata mode (research/planning/implementation/verify/close)
   * or any free-form string identifying the session's role inside its
   * arc. Threaded through to the `agent_sessions.mode` column. When
   * absent, persists as NULL — preserves today's behavior for callers
   * that don't yet supply a mode (debug / freeform / task).
   */
  mode?: string | null
  /**
   * GH#116: the id of the prior frontier session in the same arc.
   * Threaded through to `agent_sessions.parentSessionId` so the arc's
   * advance/branch chain is reconstructable from the session rows
   * alone (no separate transitions table). No FK enforcement — matches
   * the no-FK pattern used for `userTabs.sessionId`; app-level integrity
   * only.
   */
  parentSessionId?: string
  client_session_id?: string
  /**
   * GH#115: optional worktree reservation. `{kind:'fresh'}` allocates a
   * fresh clone from the registry pool; `{id}` binds to an explicit id
   * (e.g. inherited from chain predecessor). Absent => no reservation;
   * `worktreeId` stays NULL on the session row (today's behavior).
   */
  worktree?: SessionWorktreeParam | null
}

export type CreateSessionResult =
  | { ok: true; sessionId: string; arcId: string }
  | { ok: false; status: number; error: string }

export async function createSession(
  env: Env,
  userId: string,
  params: CreateSessionParams,
  executionCtx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<CreateSessionResult> {
  if (!params.project) {
    return { ok: false, status: 400, error: 'Missing required field: project' }
  }
  // Prompt is now optional — empty/missing prompt routes to the DO's
  // prompt-less `initialize()` path so the runner is deferred until the
  // first sendMessage. See SessionDO.initialize / sendMessage fresh-execute.

  if (params.kataIssue !== undefined && params.kataIssue !== null) {
    if (!Number.isInteger(params.kataIssue) || params.kataIssue <= 0) {
      return { ok: false, status: 400, error: 'invalid_kata_issue' }
    }
  }

  // Spec #68 B6 — inherit the project's visibility at creation time. Projects
  // default to 'public'; restricting to 'private' happens via the admin
  // PATCH endpoint. New sessions adopt whatever the project is set to today,
  // falling back to 'public' when the project row is missing (fresh project
  // the gateway hasn't synced yet, etc.) — matches the project default so
  // cold-start doesn't silently collapse to 'private'.
  const db = drizzle(env.AUTH_DB, { schema })
  const projectRows = await db
    .select({ visibility: schema.projects.visibility })
    .from(schema.projects)
    .where(eq(schema.projects.name, params.project))
    .limit(1)
  const visibility: 'public' | 'private' =
    projectRows[0]?.visibility === 'private' ? 'private' : 'public'

  // GH#115 P1.2: allocate the session id BEFORE worktree reservation so
  // we can derive `reservedBy: {kind:'session', id: <sessionId>}` for
  // sessions that have no kataIssue. Previously this block lived after
  // the projectPath resolution; the reordering is benign.
  let sessionId: string
  let doId: DurableObjectId
  if (params.client_session_id !== undefined) {
    if (
      !CLIENT_SESSION_ID_RE.test(params.client_session_id) ||
      /^[0-9a-f]{64}$/.test(params.client_session_id)
    ) {
      return { ok: false, status: 400, error: 'invalid_client_session_id' }
    }
    sessionId = params.client_session_id
    doId = env.SESSION_AGENT.idFromName(sessionId)
  } else {
    doId = env.SESSION_AGENT.newUniqueId()
    sessionId = doId.toString()
  }
  const sessionDO = env.SESSION_AGENT.get(doId)

  // GH#115 P1.2: optional worktree reservation. `{kind:'fresh'}` allocates
  // from the pool, `{id}` binds explicitly; absent => no reservation
  // (today's back-compat path). The derived `reservedBy` follows the
  // explicit rule from spec §B-API-5: arc when kataIssue is a positive
  // integer, session otherwise. `kind:'manual'` is reserved for setup
  // ceremony / discovery sweep — never assigned by this endpoint.
  let reservedWorktreeId: string | null = null
  let reservedWorktreePath: string | null = null
  if (params.worktree) {
    const reservedBy: ReservedBy =
      typeof params.kataIssue === 'number' &&
      Number.isInteger(params.kataIssue) &&
      params.kataIssue > 0
        ? { kind: 'arc', id: params.kataIssue }
        : { kind: 'session', id: sessionId }

    if ('id' in params.worktree) {
      const bind = await bindWorktreeById(db, params.worktree.id, reservedBy, userId)
      if (!bind.ok && bind.kind === 'not_found') {
        return { ok: false, status: 404, error: 'worktree_not_found' }
      }
      if (!bind.ok && bind.kind === 'conflict') {
        return { ok: false, status: 409, error: 'worktree_conflict' }
      }
      if (bind.ok) {
        reservedWorktreeId = bind.row.id
        reservedWorktreePath = bind.row.path
      }
    } else if (params.worktree.kind === 'fresh') {
      const reserve = await reserveFreshWorktree(db, reservedBy, userId)
      if (!reserve.ok && reserve.kind === 'pool_exhausted') {
        return { ok: false, status: 503, error: 'pool_exhausted' }
      }
      if (reserve.ok) {
        reservedWorktreeId = reserve.row.id
        reservedWorktreePath = reserve.row.path
      }
    }
  }

  // Without a worktree reservation, fall back to today's behavior:
  // gateway-side resolution of `/projects/<name>` -> absolute path.
  const projectPath = reservedWorktreePath ?? (await resolveProjectPath(env, params.project))

  const now = new Date().toISOString()
  const promptText = promptToPreviewText(params.prompt)

  // ── Arc resolution (GH#116 B4) ───────────────────────────────────────
  // Every session row requires `arcId`. Resolution order:
  //   1. explicit `params.arcId`
  //   2. legacy `params.kataIssue` -> lookup/create arc keyed on
  //      externalRef={provider:'github', id}
  //   3. implicit auto-create -> draft arc titled from prompt preview
  const arcId = await resolveArcId(db, userId, params, promptText, now)

  const baseRow = {
    id: sessionId,
    userId,
    arcId,
    project: params.project,
    status: 'running',
    model: params.model ?? null,
    runnerSessionId: params.runner_session_id ?? null,
    createdAt: now,
    updatedAt: now,
    lastActivity: now,
    numTurns: null as number | null,
    prompt: promptText,
    summary: null as string | null,
    title: null as string | null,
    tag: null as string | null,
    origin: 'duraclaw',
    agent: params.agent ?? 'claude',
    archived: false,
    durationMs: null as number | null,
    totalCostUsd: null as number | null,
    // GH#116: `mode` replaces `kataMode`. Caller-supplied mode threads
    // through (advanceArcImpl / branchArcImpl pass it explicitly);
    // default null preserves today's behavior for freeform / debug / task
    // sessions that have no kata methodology mode.
    mode: params.mode ?? null,
    // GH#116: parent frontier session in the same arc (advance) or in
    // the parent arc (branch). NULL for the first session in any arc.
    // No FK enforcement — app-level integrity only.
    parentSessionId: params.parentSessionId ?? null,
    visibility,
    // GH#115: persist FK so chain auto-advance + status updates can
    // resolve the worktree without joining through (kataIssue, project).
    worktreeId: reservedWorktreeId,
  }

  // ── D1 INSERT FIRST ──────────────────────────────────────────────────
  // The D1 row MUST exist before the DO spawns the runner. Without it,
  // every API route gates on getAccessibleSession() → 404, so the client
  // can never fetch messages for a session that ran successfully.
  // See: GH incident sess-d62bb777 — DO ran, D1 INSERT failed silently,
  // session became permanently unreachable.
  if (params.runner_session_id) {
    await db
      .insert(agentSessions)
      .values(baseRow)
      .onConflictDoUpdate({
        target: agentSessions.runnerSessionId,
        set: {
          id: sessionId,
          userId,
          project: params.project,
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

  // ── Now spawn the DO ─────────────────────────────────────────────────
  // If this fails, the D1 row exists with status='running' but no runner.
  // The next sendMessage will see no gateway conn and re-trigger spawn,
  // or the reaper will eventually mark it idle — both are recoverable.
  const createResponse = await sessionDO.fetch(
    new Request('https://session/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-partykit-room': sessionId,
        'x-user-id': userId,
      },
      body: JSON.stringify({
        project: params.project,
        project_path: projectPath,
        prompt: params.prompt,
        model: params.model,
        system_prompt: params.system_prompt,
        runner_session_id: params.runner_session_id,
        agent: params.agent,
        userId,
        // GH#115: persist FK on SessionMeta so triggerGatewayDial can
        // stamp `worktree_path` on execute/resume commands.
        worktreeId: reservedWorktreeId,
      }),
    }),
  )

  if (!createResponse.ok) {
    // DO spawn failed — mark the D1 row as errored so it doesn't sit
    // as a phantom 'running' session forever.
    await db
      .update(agentSessions)
      .set({ status: 'error', updatedAt: new Date().toISOString() })
      .where(eq(agentSessions.id, sessionId))
    return { ok: false, status: 500, error: 'Failed to create session' }
  }

  await broadcastSessionRow(env, executionCtx, sessionId, 'insert')

  // Spec: kanban board reactivity. New chain-tagged sessions reshape the
  // chain summary (column derives from sessions, sessions list grows by
  // one). Without this delta the board only repaints on cold load or the
  // eventual SessionDO `syncKataToD1` broadcast — visibly stale for the
  // few seconds between spawn and first kata-state event.
  if (typeof params.kataIssue === 'number' && Number.isFinite(params.kataIssue)) {
    await broadcastChainRow(env, executionCtx, params.kataIssue, { actorUserId: userId })
  }

  return { ok: true, sessionId, arcId }
}

// ─── Arc resolution helpers (GH#116 B4) ──────────────────────────────────
// Used only by createSession. Kept colocated rather than exported via
// `lib/arcs.ts` because (a) `lib/arcs.ts` doesn't exist yet (it lands in
// the same P1.1 wave but as a separate file with read-side helpers), and
// (b) the arc-resolution policy (explicit -> kataIssue -> implicit) is
// session-creation-specific. If a second caller emerges, lift then.

type Db = ReturnType<typeof drizzle<typeof schema>>

const ARC_ID_PREFIX = 'arc_'
const IMPLICIT_TITLE_MAX = 50
const IMPLICIT_TITLE_FALLBACK = 'Untitled session'

function newArcId(): string {
  return `${ARC_ID_PREFIX}${crypto.randomUUID()}`
}

function buildImplicitTitle(promptText: string): string {
  const trimmed = promptText.trim()
  if (!trimmed) return IMPLICIT_TITLE_FALLBACK
  if (trimmed.length <= IMPLICIT_TITLE_MAX) return trimmed
  return `${trimmed.slice(0, IMPLICIT_TITLE_MAX)}…`
}

/**
 * Resolve the arcId for a new session per spec 116 B4.
 *
 * Preference order:
 *   1. explicit `params.arcId` — caller already minted/owns an arc.
 *   2. legacy `params.kataIssue` — find-or-create an arc with
 *      `externalRef={provider:'github', id}` for this user. Wraps the
 *      create in try/catch so a concurrent caller racing on the same
 *      issue (caught by the `idx_arcs_external_ref` unique index) falls
 *      back to the SELECT path instead of erroring out.
 *   3. implicit — draft arc with `externalRef=null`, title derived from
 *      the prompt preview (or 'Untitled session' if the prompt is
 *      empty). Used by debug / freeform sessions and renders flat in
 *      the sidebar (B4 UI clause).
 */
async function resolveArcId(
  db: Db,
  userId: string,
  params: CreateSessionParams,
  promptText: string,
  now: string,
): Promise<string> {
  // (1) Explicit arcId — trust the caller; the FK constraint will fail
  // loudly downstream if the id doesn't exist or doesn't belong to this
  // user, which is the right failure mode for a programmer error.
  if (typeof params.arcId === 'string' && params.arcId.length > 0) {
    return params.arcId
  }

  // (2) Legacy kataIssue — find-or-create an arc keyed on the GH issue.
  if (typeof params.kataIssue === 'number' && Number.isFinite(params.kataIssue)) {
    const issueId = params.kataIssue
    const found = await db
      .select({ id: arcs.id })
      .from(arcs)
      .where(
        and(
          eq(arcs.userId, userId),
          sql`json_extract(${arcs.externalRef}, '$.provider') = 'github'`,
          sql`json_extract(${arcs.externalRef}, '$.id') = ${issueId}`,
        ),
      )
      .limit(1)
    if (found[0]?.id) return found[0].id

    const newId = newArcId()
    const externalRef = JSON.stringify({
      provider: 'github',
      id: issueId,
      url: `https://github.com/baseplane-ai/duraclaw/issues/${issueId}`,
    })
    try {
      await db.insert(arcs).values({
        id: newId,
        userId,
        title: `Issue #${issueId}`,
        externalRef,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })
      return newId
    } catch (err) {
      // Concurrent caller created the arc first — `idx_arcs_external_ref`
      // unique index trips. Re-select; if the row is now visible, use it.
      const raced = await db
        .select({ id: arcs.id })
        .from(arcs)
        .where(
          and(
            eq(arcs.userId, userId),
            sql`json_extract(${arcs.externalRef}, '$.provider') = 'github'`,
            sql`json_extract(${arcs.externalRef}, '$.id') = ${issueId}`,
          ),
        )
        .limit(1)
      if (raced[0]?.id) return raced[0].id
      throw err
    }
  }

  // (3) Implicit arc — draft status, no externalRef. Renders flat in
  // sidebar (one-session, no externalRef, no parent).
  const implicitId = newArcId()
  await db.insert(arcs).values({
    id: implicitId,
    userId,
    title: buildImplicitTitle(promptText),
    externalRef: null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  })
  return implicitId
}
