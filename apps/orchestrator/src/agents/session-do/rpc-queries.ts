import type {
  SyncedCollectionOp,
  SessionMessage as WireSessionMessage,
} from '@duraclaw/shared-types'
import { eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import { chunkOps } from '~/lib/chunk-frame'
import type { ContextUsage, KataSessionState } from '~/lib/types'
import { computeBranchInfo as computeBranchInfoImpl } from './branches'
import {
  broadcastBranchInfo as broadcastBranchInfoImpl,
  broadcastMessages as broadcastMessagesImpl,
} from './broadcast'
import { deriveSnapshotOps } from './history'
import { hydrateFromGatewayImpl } from './hydrate-from-gateway'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted bodies for read-side @callable RPCs —
 * `getContextUsage`, `getKataState`, `getMessages`, plus the
 * `probeContextUsageWithTimeout` helper.
 *
 * `contextUsageProbeInFlight` and `contextUsageResolvers` continue to
 * live as DO-class fields (single-flight requires shared mutable state),
 * accessed through `ctx.do`.
 */

export async function getContextUsageImpl(ctx: SessionDOContext): Promise<{
  contextUsage: ContextUsage | null
  fetchedAt: string
  isCached: boolean
}> {
  const rows = [
    ...ctx.sql.exec<{
      context_usage_json: string | null
      context_usage_cached_at: number | null
    }>('SELECT context_usage_json, context_usage_cached_at FROM session_meta WHERE id = 1'),
  ]
  const row = rows[0]
  const cached =
    row?.context_usage_json && row.context_usage_cached_at != null
      ? {
          value: JSON.parse(row.context_usage_json) as ContextUsage,
          cachedAt: row.context_usage_cached_at,
        }
      : null
  const now = Date.now()
  if (cached && now - cached.cachedAt < 5_000) {
    return {
      contextUsage: cached.value,
      fetchedAt: new Date(cached.cachedAt).toISOString(),
      isCached: true,
    }
  }
  // #102: get-context-usage command and context_usage event were removed.
  // Context usage is now extracted from the result event. Always return
  // the cached value (populated by the result event handler).
  return {
    contextUsage: cached?.value ?? null,
    fetchedAt: cached ? new Date(cached.cachedAt).toISOString() : new Date().toISOString(),
    isCached: true,
  }
}

// probeContextUsageWithTimeoutImpl removed by #102 — get-context-usage
// command and context_usage event no longer exist on the wire. Context
// usage is now extracted from the result event.

export async function getKataStateImpl(
  ctx: SessionDOContext,
): Promise<{ kataState: KataSessionState | null; fetchedAt: string }> {
  const sessionId = ctx.do.name
  try {
    const rows = await ctx.do.d1
      .select({
        kataMode: agentSessions.kataMode,
        kataIssue: agentSessions.kataIssue,
        kataPhase: agentSessions.kataPhase,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1)
    const row = rows[0]
    if (!row || (row.kataMode == null && row.kataIssue == null && row.kataPhase == null)) {
      return { kataState: null, fetchedAt: new Date().toISOString() }
    }
    // Read the full kata_state blob from the kv table for richer fields if present.
    const kvRows = [
      ...ctx.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'kata_state'"),
    ]
    const kvKata = kvRows[0]?.value ? (JSON.parse(kvRows[0].value) as KataSessionState) : null
    if (kvKata) {
      return { kataState: kvKata, fetchedAt: new Date().toISOString() }
    }
    // Fallback: synthesize a minimal KataSessionState from D1 columns.
    const minimal: KataSessionState = {
      sessionId,
      workflowId: null,
      issueNumber: row.kataIssue ?? null,
      sessionType: null,
      currentMode: row.kataMode ?? null,
      currentPhase: row.kataPhase ?? null,
      completedPhases: [],
      template: null,
      phases: [],
      modeHistory: [],
      modeState: {},
      updatedAt: new Date().toISOString(),
      beadsCreated: [],
      editedFiles: [],
    }
    return { kataState: minimal, fetchedAt: new Date().toISOString() }
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] getKataState failed:`, err)
    return { kataState: null, fetchedAt: new Date().toISOString() }
  }
}

export async function getMessagesImpl(
  ctx: SessionDOContext,
  opts?: {
    offset?: number
    limit?: number
    session_hint?: string
    leafId?: string
  },
): Promise<{ ok: true }> {
  // GH#57: hydration-only RPC. Message sync moved to the cursor-aware
  // `subscribe:messages` WS frame handled in `onMessage`, which is
  // bounded and doesn't call `getHistory()`. This RPC only runs the
  // discovered-session bootstrap + gateway transcript catch-up side
  // effects; the return value is intentionally opaque — callers should
  // not depend on it for history.
  //
  // Self-initialize from D1 for discovered sessions (#7 p6). The cron in
  // src/api/scheduled.ts UPSERTs gateway-discovered rows into agent_sessions
  // every 5 minutes; this just rehydrates a cold DO from that row when
  // the browser hits a session whose DO has no in-memory state yet.
  if (!ctx.state.runner_session_id && opts?.session_hint) {
    try {
      const rows = await ctx.do.d1
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, opts.session_hint))
        .limit(1)
      const row = rows[0]
      if (row?.runnerSessionId) {
        ctx.do.updateState({
          runner_session_id: row.runnerSessionId,
          project: row.project ?? '',
          session_id: row.id,
          summary: row.summary ?? null,
          started_at: row.createdAt || ctx.state.created_at || new Date().toISOString(),
          created_at: row.createdAt || ctx.state.created_at || new Date().toISOString(),
        })
      }
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] Failed to init from D1:`, err)
    }
  }

  // Hydrate from VPS gateway — only for discovered sessions with empty
  // local history (cold DO that has never received live events). Sessions
  // that already have messages don't need re-hydration — the cursor-aware
  // `subscribe:messages` replay fills any gap. Running hydrateFromGateway
  // unconditionally was the root cause of idle-reconnect duplicate replay:
  // the merge path calls safeUpdateMessage on existing rows, which bumps
  // modified_at to now(), making them appear "newer than cursor" on the
  // immediately-following subscribe replay. See GH#78 addendum B.
  if (ctx.state.runner_session_id && ctx.state.project && ctx.session.getPathLength() === 0) {
    await hydrateFromGatewayImpl(ctx)
  }

  return { ok: true }
}

export async function getBranchHistoryImpl(
  ctx: SessionDOContext,
  leafId: string,
): Promise<{ ok: true } | { ok: false; error: 'unknown_leaf' | 'not_on_branch' }> {
  const history = ctx.session.getHistory()
  const found = history.find((m) => m.id === leafId)
  if (!found) return { ok: false, error: 'unknown_leaf' }
  if (found.role !== 'user') return { ok: false, error: 'not_on_branch' }
  // Known limitation: scope branch-navigate snapshot to the requesting
  // client once `@callable` surfaces the caller connection id. The agents
  // SDK (v0.11) dispatches RPCs via `super.onMessage` with no public
  // callback for caller identity, so we broadcast to all browser
  // connections. Harmless over-delivery — matches B1 correctness and the
  // client's per-session `lastSeq` watermark still drops stale frames.
  const messages = ctx.session.getHistory(leafId) ?? history
  // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
  // staleIds = rows on the current default leaf but NOT on the target
  // branch's leaf. `history` here is the default-leaf view (from above).
  const { ops } = deriveSnapshotOps<WireSessionMessage>({
    oldLeaf: history as unknown as WireSessionMessage[],
    newLeaf: messages as unknown as WireSessionMessage[],
  })
  for (const chunk of chunkOps(ops)) {
    broadcastMessagesImpl(ctx, { ops: chunk as SyncedCollectionOp<WireSessionMessage>[] })
  }
  // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO turn.
  broadcastBranchInfoImpl(ctx, computeBranchInfoImpl(ctx, messages))
  return { ok: true }
}

export async function requestSnapshotImpl(
  ctx: SessionDOContext,
  opts: { targetClientId?: string } = {},
): Promise<{ ok: true } | { ok: false; error: 'session_empty' }> {
  const messages = ctx.session.getHistory()
  if (messages.length === 0) return { ok: false, error: 'session_empty' }
  // GH#75: client passes its PartySocket `connection.id` as
  // `targetClientId`. When present, forward to the targeted paths so
  // both the messages frame and the sibling branchInfo frame carry
  // `targeted: true` and land only on the requesting connection —
  // non-recipients stay aligned with the shared seq stream.
  // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
  // staleIds = [] — a client-requested resync has no known prior state
  // from the server's perspective; fresh is the full history.
  const { ops } = deriveSnapshotOps<WireSessionMessage>({
    oldLeaf: [],
    newLeaf: messages as unknown as WireSessionMessage[],
  })
  for (const chunk of chunkOps(ops)) {
    broadcastMessagesImpl(ctx, { ops: chunk as SyncedCollectionOp<WireSessionMessage>[] }, opts)
  }
  // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO turn.
  broadcastBranchInfoImpl(ctx, computeBranchInfoImpl(ctx, messages), opts)
  return { ok: true }
}

export async function getKataStatusImpl(ctx: SessionDOContext): Promise<unknown> {
  const rows = [...ctx.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'kata_state'")]
  if (rows.length === 0) return null
  try {
    return JSON.parse(rows[0].value)
  } catch {
    return null
  }
}

export async function getStatusImpl(
  ctx: SessionDOContext,
): Promise<{ state: typeof ctx.state; recent_events: never[] }> {
  return { state: ctx.state, recent_events: [] }
}
