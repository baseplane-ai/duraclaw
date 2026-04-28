import type { AdapterCapabilities } from '@duraclaw/shared-types'
import { and, eq } from 'drizzle-orm'
import { agentSessions, worktreeReservations } from '~/db/schema'
import { broadcastSessionRow } from '~/lib/broadcast-session'
import type { KataSessionState } from '~/lib/types'
import { broadcastChainUpdate, broadcastStatusFrame, broadcastStatusToOwner } from './broadcast'
import type { SessionMeta } from './index'
import { META_COLUMN_MAP, type SessionDOContext } from './types'

/**
 * Spec #101 Stage 2: status / D1-sync extraction.
 *
 * Owns the SessionMeta state-machine entry points (`updateState` /
 * `persistMetaPatch`) plus all D1 reflection helpers that snapshot the
 * authoritative DO state into `agent_sessions` rows.
 */

/**
 * Patch-merge into the Agent's state blob and mirror the durable subset
 * into `session_meta` (migration v7). Fields without a column mapping
 * (e.g. `updated_at`, `result`) stay only in the in-memory JSON blob —
 * clients no longer consume them and DO rehydrate pulls from SQLite.
 *
 * On status transitions, also pushes a status-only frame to clients and
 * mirrors status to the owner's user-stream so background sessions see
 * the change without a per-session WS.
 */
export function updateState(ctx: SessionDOContext, partial: Partial<SessionMeta>): void {
  const prevStatus = ctx.state.status
  // GH#119 P3: canonical reset point for the waiting_identity retry
  // counter. Any transition into a terminal state (`idle` / `error`) or
  // a successful failover (`failover`) clears the counter so a future
  // rate-limit on the same session starts the alarm-loop budget fresh.
  // The caller may override by passing an explicit
  // `waiting_identity_retries` in `partial` (handleRateLimit /
  // checkWaitingIdentity do this when bumping or zeroing intentionally).
  let normalized: Partial<SessionMeta> = partial
  if (
    partial.status !== undefined &&
    partial.waiting_identity_retries === undefined &&
    (partial.status === 'idle' || partial.status === 'error' || partial.status === 'failover')
  ) {
    normalized = { ...partial, waiting_identity_retries: 0 }
  }
  ctx.do.setState({
    ...ctx.state,
    ...normalized,
    updated_at: new Date().toISOString(),
  })
  persistMetaPatch(ctx, normalized)

  // Push a status-only frame to all connected clients whenever the
  // status field actually changes. This ensures the client sees every
  // transition immediately — even when no message broadcast coincides
  // with the change (e.g. result handler flips idle AFTER the final
  // message was already broadcast with the old status).
  if (partial.status !== undefined && partial.status !== prevStatus) {
    broadcastStatusFrame(ctx)
    // Push status to the owner's user-stream (via UserSettingsDO) so
    // background sessions (sidebar, tabs) see transitions without a
    // per-session WS. Fire-and-forget via waitUntil — no D1 write.
    broadcastStatusToOwner(ctx)
  }
}

/**
 * D1 → SQLite mirror of a SessionMeta patch. Walks the column map and
 * writes the matching `session_meta` columns. Best-effort: a failure is
 * logged and swallowed so a SQLite hiccup never crashes the caller.
 */
export function persistMetaPatch(ctx: SessionDOContext, partial: Partial<SessionMeta>): void {
  const cols: string[] = []
  const vals: unknown[] = []
  for (const [key, value] of Object.entries(partial) as Array<
    [keyof SessionMeta, SessionMeta[keyof SessionMeta]]
  >) {
    const col = META_COLUMN_MAP[key]
    if (!col) continue
    if (key === 'lastRunEnded') {
      // INTEGER 0/1 column (migration v13). undefined → 0 so the default
      // "not yet ended" state is explicit rather than SQL NULL.
      cols.push(`${col} = ?`)
      vals.push(value ? 1 : 0)
    } else if (key === 'capabilities') {
      // Spec #101 P1.2 B7: capabilities_json is TEXT JSON. Stringify
      // here so persistMetaPatch keeps the typed in-memory shape on the
      // SessionMeta side and DB-typed JSON on the SQLite side.
      cols.push(`${col} = ?`)
      vals.push(value == null ? null : JSON.stringify(value))
    } else {
      cols.push(`${col} = ?`)
      vals.push(value ?? null)
    }
  }
  if (cols.length === 0) return
  cols.push('updated_at = ?')
  vals.push(Date.now())
  try {
    ctx.sql.exec(
      `UPDATE session_meta SET ${cols.join(', ')} WHERE id = 1`,
      ...(vals as (string | number | null)[]),
    )
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] persistMetaPatch failed:`, err)
  }
}

/**
 * Reflect the result-handler payload (summary, cost, turns, duration) onto
 * the D1 `agent_sessions` row and broadcast a session-row update so the
 * sidebar / history view sees the post-stop snapshot.
 */
export async function syncResultToD1(ctx: SessionDOContext, updatedAt: string): Promise<void> {
  try {
    const sessionId = ctx.do.name
    await ctx.do.d1
      .update(agentSessions)
      .set({
        status: 'idle',
        summary: ctx.state.summary,
        durationMs: ctx.state.duration_ms,
        totalCostUsd: ctx.state.total_cost_usd,
        numTurns: ctx.state.num_turns,
        messageSeq: ctx.do.messageSeq,
        updatedAt,
        lastActivity: updatedAt,
      })
      .where(eq(agentSessions.id, sessionId))
    await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync result to D1:`, err)
  }
}

/**
 * Persist the runner-issued `runner_session_id` onto the D1 row so REST
 * callers (resume-after-idle, orphan recovery) can re-spawn against the
 * right session identifier. The id is whatever the underlying adapter
 * uses (Claude SDK session_id, Codex thread_id, etc.) — the DO is
 * agnostic to its provenance.
 */
export async function syncRunnerSessionIdToD1(
  ctx: SessionDOContext,
  runnerSessionId: string,
  updatedAt: string,
): Promise<void> {
  try {
    const sessionId = ctx.do.name
    await ctx.do.d1
      .update(agentSessions)
      .set({ runnerSessionId, messageSeq: ctx.do.messageSeq, updatedAt })
      .where(eq(agentSessions.id, sessionId))
    await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync runner_session_id to D1:`, err)
  }
}

/**
 * GH#119 P2: persist the runner identity name onto the D1
 * `agent_sessions` row and broadcast. Called from `triggerGatewayDial`
 * after the DO selects an identity via LRU. The UI reads this column
 * via the synced `agent_sessions` collection so the active identity is
 * visible in the session sidebar (P4 surface).
 *
 * Best-effort: a D1 hiccup or broadcast failure must not crash the
 * spawn path, so the helper logs the error and returns rather than
 * throwing.
 */
export async function syncIdentityNameToD1(
  ctx: SessionDOContext,
  identityName: string | null,
  updatedAt: string,
): Promise<void> {
  try {
    const sessionId = ctx.do.name
    await ctx.do.d1
      .update(agentSessions)
      .set({ identityName, messageSeq: ctx.do.messageSeq, updatedAt })
      .where(eq(agentSessions.id, sessionId))
    await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
  } catch (err) {
    ctx.logEvent('warn', 'identity', 'failed to sync identity_name to D1', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Mirror the session's first-message preview onto the D1 row + broadcast.
 *
 * Used by the deferred-runner / `isFreshSpawnable` branch in
 * `sendMessageImpl`: a session created without an initial prompt
 * (`directCreateSession` → `initializeImpl`) lands in D1 with
 * `prompt = ''`, so the sidebar's `displayName` fallback chain
 * (`title || summary || prompt || id.slice(0,8)`) collapses to the
 * session-id prefix. Once the user submits the first turn, write the
 * preview text back so the sidebar shows something meaningful before
 * the runner-side haiku titler eventually fires (which only triggers
 * at ≥1500 transcript tokens — far too late for short conversations).
 *
 * Called only on the first turn of a deferred session. The other
 * sendMessage branches (live-runner stream-input, post-reaper resume)
 * intentionally leave `prompt` untouched — overwriting it with the most
 * recent turn would erase the original session intent.
 */
export async function syncPromptToD1(
  ctx: SessionDOContext,
  prompt: string,
  updatedAt: string,
): Promise<void> {
  try {
    const sessionId = ctx.do.name
    await ctx.do.d1
      .update(agentSessions)
      .set({ prompt, updatedAt })
      .where(eq(agentSessions.id, sessionId))
    await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync prompt to D1:`, err)
  }
}

/**
 * Spec #101 P1.2 B7: persist runner-reported AdapterCapabilities onto
 * the D1 row + broadcast. Stored as serialized JSON in
 * `agent_sessions.capabilities_json` so the sidebar / agent-detail
 * surfaces can render capability-aware UI without a DO round-trip.
 */
export async function syncCapabilitiesToD1(
  ctx: SessionDOContext,
  capabilities: AdapterCapabilities | null,
  updatedAt: string,
): Promise<void> {
  try {
    const sessionId = ctx.do.name
    const capabilitiesJson = capabilities ? JSON.stringify(capabilities) : null
    await ctx.do.d1
      .update(agentSessions)
      .set({ capabilitiesJson, messageSeq: ctx.do.messageSeq, updatedAt })
      .where(eq(agentSessions.id, sessionId))
    await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync capabilities to D1:`, err)
  }
}

/**
 * Consolidated kata write: one UPDATE for all kata columns
 * (kataMode, kataIssue, kataPhase, kataStateJson) + one broadcast.
 * Also refreshes the worktree reservation activity and broadcasts the
 * chain row, mirroring `syncKataToD1`'s side effects.
 */
export async function syncKataAllToD1(
  ctx: SessionDOContext,
  kataState: KataSessionState | null,
  updatedAt: string,
): Promise<void> {
  try {
    const sessionId = ctx.do.name
    await ctx.do.d1
      .update(agentSessions)
      .set({
        kataMode: kataState?.currentMode ?? null,
        kataIssue: kataState?.issueNumber ?? null,
        kataPhase: kataState?.currentPhase ?? null,
        kataStateJson: kataState ? JSON.stringify(kataState) : null,
        messageSeq: ctx.do.messageSeq,
        updatedAt,
      })
      .where(eq(agentSessions.id, sessionId))
    await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync kata (all) to D1:`, err)
  }

  // Mirror `syncKataToD1` side effects: refresh worktree reservation
  // last_activity_at (clears stale flag) and broadcast updated chains row.
  if (kataState?.issueNumber != null && ctx.state.project) {
    try {
      await ctx.do.d1
        .update(worktreeReservations)
        .set({ lastActivityAt: updatedAt, stale: false })
        .where(
          and(
            eq(worktreeReservations.issueNumber, kataState.issueNumber),
            eq(worktreeReservations.worktree, ctx.state.project),
          ),
        )
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] failed to refresh reservation activity:`, err)
    }
  }

  broadcastChainUpdate(ctx, kataState?.issueNumber ?? null)
}

/**
 * Spec #37 P1b: defined but not yet wired — there is no callsite in the
 * DO that builds a WorktreeInfo JSON object today. Leaving this in place
 * so the follow-up (worktree-info resolution) can attach without a new
 * helper. Do not remove.
 */
export async function syncWorktreeInfoToD1(
  ctx: SessionDOContext,
  worktreeInfoJson: string | null,
  updatedAt: string,
): Promise<void> {
  try {
    const sessionId = ctx.do.name
    await ctx.do.d1
      .update(agentSessions)
      .set({ worktreeInfoJson, messageSeq: ctx.do.messageSeq, updatedAt })
      .where(eq(agentSessions.id, sessionId))
    await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync worktree_info_json to D1:`, err)
  }
}

/**
 * State for the 5s trailing-edge `context_usage` debounce. Owned by the
 * DO instance (one slot per DO) and mutated via `scheduleContextUsageSync`
 * — module-local module state would leak across DO instances during
 * Workers' per-isolate sharing.
 */
export interface ContextUsageDebounceState {
  timer: ReturnType<typeof setTimeout> | null
  pending: string | null
}

/**
 * 5s trailing-edge debounce for context_usage D1 writes — matches the
 * `session_meta.context_usage_cached_at` TTL. See spec #37 B5.
 *
 * Caller owns the debounce-state slot (`ctx.do.contextUsageDebounce`).
 */
export function syncContextUsageToD1(
  ctx: SessionDOContext,
  debounce: ContextUsageDebounceState,
  json: string,
): void {
  debounce.pending = json
  if (debounce.timer) return
  debounce.timer = setTimeout(() => {
    debounce.timer = null
    const pending = debounce.pending
    debounce.pending = null
    if (pending == null) return
    void (async () => {
      try {
        const sessionId = ctx.do.name
        const updatedAt = new Date().toISOString()
        await ctx.do.d1
          .update(agentSessions)
          .set({ contextUsageJson: pending, messageSeq: ctx.do.messageSeq, updatedAt })
          .where(eq(agentSessions.id, sessionId))
        await broadcastSessionRow(ctx.env, ctx.ctx, sessionId, 'update')
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] Failed to sync context_usage to D1:`, err)
      }
    })()
  }, 5000)
}
