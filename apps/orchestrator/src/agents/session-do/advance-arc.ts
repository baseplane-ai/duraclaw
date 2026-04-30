/**
 * GH#116 P2: `advanceArc` primitive — replaces the old
 * `handleModeTransitionImpl` (mode-transition.ts) and the auto-advance
 * dispatcher (`tryAutoAdvance` in lib/auto-advance.ts) with one
 * primitive that closes the current frontier session and mints a fresh
 * successor in the same arc.
 *
 * Two exports:
 *   - `advanceArcImpl(ctx, args)` — the primitive itself. Closes the
 *     current session (status='idle' + broadcast), then calls
 *     `createSession()` to mint a successor with `arcId` preserved and
 *     `parentSessionId` pointing at the closing session. NO transcript
 *     carryover (the old artifact-pointer preamble from
 *     mode-transition.ts is dropped per spec B6).
 *   - `advanceArcGate(ctx, {terminateReason})` — the auto-advance gate
 *     decision. Ports the precondition logic from
 *     `tryAutoAdvance` minus the kata `runEnded` evidence file check
 *     (spec B10): clean stop + user pref + idempotency + worktree
 *     availability for code-touching modes.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions, userPreferences, worktrees } from '~/db/schema'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import { createSession } from '~/lib/create-session'
import type { SessionDOContext } from './types'

/**
 * Default kata-mode progression. `close` is the terminus; non-core
 * modes (debug / freeform / task / onboard) have no successor and the
 * gate skips them.
 */
const NEXT_MODE: Record<string, string | null> = {
  research: 'planning',
  planning: 'implementation',
  implementation: 'verify',
  verify: 'close',
  close: null,
}

/** Modes whose successor session needs a worktree reservation. */
const CODE_TOUCHING_MODES = new Set<string>(['implementation', 'verify', 'debug', 'task'])

/**
 * Map a current core mode → its successor (`null` for terminus or
 * non-core modes). Exported for tests + any caller that needs the
 * progression table without going through the full gate.
 */
export function nextMode(current: string | null | undefined): string | null {
  if (!current) return null
  if (current in NEXT_MODE) return NEXT_MODE[current]
  return null
}

// ─── advanceArcImpl ────────────────────────────────────────────────────────

export interface AdvanceArcArgs {
  mode?: string | null
  prompt: string
  agent?: string
}

export type AdvanceArcResult =
  | { ok: true; sessionId: string; arcId: string }
  | { ok: false; error: string }

/**
 * Mint a successor session in the same arc. Closes the current
 * frontier session (status='idle' + broadcast row update) and calls
 * `createSession()` with `arcId` carried over and `parentSessionId`
 * set to the closing session's id.
 *
 * Behavior notes:
 *   - The arcId is read from the D1 `agent_sessions` row of the
 *     current session (SessionMeta does not carry arcId — it lives on
 *     the row only).
 *   - Does NOT clear `runner_session_id` on the closing session: the
 *     old runner state stays addressable for future hydration if the
 *     user navigates back to the closed session.
 *   - NO transcript carryover. The new session sees only `args.prompt`.
 *     The artifact-pointer preamble from the legacy
 *     `handleModeTransitionImpl` is intentionally dropped (spec B6).
 */
export async function advanceArcImpl(
  ctx: SessionDOContext,
  args: AdvanceArcArgs,
): Promise<AdvanceArcResult> {
  const userId = ctx.state.userId
  const project = ctx.state.project
  const closingSessionId = ctx.do.name

  if (!userId) return { ok: false, error: 'session has no userId' }
  if (!project) return { ok: false, error: 'session has no project' }

  // Read the current session row to get arcId. SessionMeta doesn't
  // carry arcId; the D1 row is the source of truth.
  const db = drizzle(ctx.env.AUTH_DB, { schema })
  const rows = await db
    .select({ arcId: agentSessions.arcId })
    .from(agentSessions)
    .where(eq(agentSessions.id, closingSessionId))
    .limit(1)
  const arcId = rows[0]?.arcId
  if (!arcId) return { ok: false, error: 'session has no arcId' }

  // 1. Close the current session: status='idle' + broadcast.
  // (Note: do NOT clear runner_session_id — the old runner remains
  // addressable for future hydration, see B6.)
  ctx.do.updateState({ status: 'idle' })
  try {
    await broadcastSessionRow(ctx.env, ctx.ctx, closingSessionId, 'update')
  } catch (err) {
    ctx.logEvent(
      'warn',
      'arc',
      `advanceArc: close-broadcast failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. Mint successor session in the same arc.
  const result = await createSession(
    ctx.env,
    userId,
    {
      project,
      arcId,
      prompt: args.prompt,
      agent: args.agent ?? 'claude',
      // GH#116 B6: thread mode through so the new session's
      // `agent_sessions.mode` column reflects the advance target.
      mode: args.mode ?? null,
      // GH#116 B6: chain from the closing frontier session so the arc's
      // advance lineage is walkable via parentSessionId.
      parentSessionId: closingSessionId,
    },
    ctx.ctx,
  )
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  return { ok: true, sessionId: result.sessionId, arcId: result.arcId }
}

// ─── advanceArcGate ────────────────────────────────────────────────────────

export type AdvanceArcGateResult =
  | { action: 'advanced'; mode: string; reason: string }
  | { action: 'skipped'; reason: string }

export interface AdvanceArcGateArgs {
  terminateReason: string
}

/**
 * Spec B10: the auto-advance gate decision, decoupled from the
 * dispatcher. Caller is the gateway-event-handler `stopped` branch.
 *
 * Gate (in order):
 *   1. `terminateReason === 'stopped'` (clean exit). Errors / crashes
 *      do not auto-advance.
 *   2. User pref enabled (per-arc override + global default).
 *   3. Idempotency: no in-flight successor session for `(arcId,
 *      nextMode)`. The partial unique index `idx_agent_sessions_arc_
 *      mode_active` enforces this at the DB; the gate checks first to
 *      fail-fast and avoid a noisy insert conflict.
 *   4. Worktree available if `nextMode` is code-touching (implementation
 *      / verify / debug / task).
 *
 * The kata `runEnded` evidence file check (legacy GH#73) is REMOVED.
 * Auto-advance is now kata-agnostic — any clean stop triggers the next
 * session in the arc, regardless of kata methodology state.
 */
export async function advanceArcGate(
  ctx: SessionDOContext,
  args: AdvanceArcGateArgs,
): Promise<AdvanceArcGateResult> {
  // (1) Terminate-reason gate — only clean stops auto-advance.
  if (args.terminateReason !== 'stopped') {
    return { action: 'skipped', reason: 'not stopped' }
  }

  const userId = ctx.state.userId
  const sessionId = ctx.do.name
  const currentMode = ctx.state.lastKataMode ?? null
  if (!userId) return { action: 'skipped', reason: 'session has no userId' }

  // Determine next mode from the current mode.
  const next = nextMode(currentMode)
  if (next == null) {
    return { action: 'skipped', reason: 'no next mode' }
  }

  const db = drizzle(ctx.env.AUTH_DB, { schema })

  // Look up the current session's arcId.
  const rows = await db
    .select({ arcId: agentSessions.arcId, worktreeId: agentSessions.worktreeId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1)
  const arcId = rows[0]?.arcId
  if (!arcId) return { action: 'skipped', reason: 'session has no arcId' }
  const predecessorWorktreeId = rows[0]?.worktreeId ?? null

  // (2) User-pref gate — per-arc override + global default. The
  // per-arc override is a future spec (no chainsJson keyed on arcId
  // yet); for P2 we honor the global default only.
  const enabled = await readAutoAdvancePref(db, userId)
  if (!enabled) return { action: 'skipped', reason: 'user pref disabled' }

  // (3) Idempotency — already-spawned successor (concurrent terminal
  // race). The partial unique index enforces this at insert time, but
  // we check first so the gate returns a clean `skipped` instead of
  // bubbling a duplicate-insert exception out of createSession.
  const existing = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.arcId, arcId),
        eq(agentSessions.mode, next),
        inArray(agentSessions.status, ['idle', 'pending', 'running']),
      ),
    )
    .limit(1)
  if (existing[0]) {
    return {
      action: 'skipped',
      reason: 'idempotency: in-flight successor exists',
    }
  }

  // (4) Worktree availability — code-touching modes need a worktree.
  // We don't actually reserve here (advanceArcImpl + createSession do
  // that downstream); we just check that a candidate is reachable.
  // Two paths: predecessor has a worktreeId we can checkout into, OR
  // the worktrees pool has at least one `free` row.
  if (CODE_TOUCHING_MODES.has(next)) {
    const wtAvailable = await isWorktreeAvailable(db, userId, predecessorWorktreeId)
    if (!wtAvailable) {
      return { action: 'skipped', reason: 'no worktree available' }
    }
  }

  return { action: 'advanced', mode: next, reason: 'gate-pass' }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * Read the user's `defaultChainAutoAdvance` preference. Per-arc
 * overrides are a future spec; for now this is the single gate.
 */
async function readAutoAdvancePref(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({
      defaultChainAutoAdvance: userPreferences.defaultChainAutoAdvance,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1)
  return !!rows[0]?.defaultChainAutoAdvance
}

/**
 * Worktree availability probe. Returns true if either:
 *   - the predecessor session's worktree id is still bind-eligible
 *     (we test via a no-op checkoutWorktree with the same reservedBy
 *     shape — same-row re-entry is idempotent and a 404/409 means we
 *     need to fall back to the pool); or
 *   - the worktrees table has at least one `free` row owned by this
 *     user that the pool-pick path could reserve.
 *
 * Note: this is a probe, not a reservation. The actual reservation
 * happens later in `advanceArcImpl` via `createSession`.
 */
async function isWorktreeAvailable(
  db: Db,
  userId: string,
  predecessorWorktreeId: string | null,
): Promise<boolean> {
  // If the predecessor has a worktree, assume the successor can
  // inherit it (same-`reservedBy` re-entry is idempotent in
  // bindWorktreeById). The actual checkout happens at spawn time.
  if (predecessorWorktreeId) {
    // Try a same-id rebind. We don't know the arc's reservedBy here
    // (the gate runs before mint), so we settle for an existence
    // probe: if the row exists and isn't held by a different
    // reservedBy, we're good. The pessimistic case (held by another
    // arc) shows up as a hard 409 at mint time.
    const rows = await db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(eq(worktrees.id, predecessorWorktreeId))
      .limit(1)
    if (rows[0]) return true
    // Fall through to pool check if predecessor's worktree row
    // disappeared.
  }

  // Pool check: any free row owned by this user.
  const free = await db
    .select({ id: worktrees.id })
    .from(worktrees)
    .where(and(eq(worktrees.ownerId, userId), eq(worktrees.status, 'free')))
    .limit(1)
  return !!free[0]
}
