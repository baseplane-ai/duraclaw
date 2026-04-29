import type {
  BranchInfoRow,
  SyncedCollectionFrame,
  SyncedCollectionOp,
  SessionMessage as WireSessionMessage,
} from '@duraclaw/shared-types'
import { eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import { buildArcRow } from '~/lib/arcs'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import type { GatewayEvent } from '~/lib/types'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 2: broadcast layer extraction.
 *
 * All session-scoped fanout helpers live here. `broadcastSyncedDelta`
 * (user-scoped, cross-DO) and `broadcastSessionRow` (D1 row reflection)
 * remain in `~/lib/` — they operate at a different scope and are imported
 * directly by callers.
 *
 * Per spec B4 the old `broadcastMessage(message)` single-row wrapper is
 * removed; callers pass an array (or ops form) directly to
 * `broadcastMessages`.
 */

/**
 * Base WS fanout — sends a stringified frame to every browser connection
 * attached to the DO, skipping the gateway/runner connection.
 *
 * Surfaces broadcast-drop failures so we can diagnose frames that never
 * reach the client (e.g. socket closed mid-send). See GH#75 B6.
 */
export function broadcastToClients(ctx: SessionDOContext, data: string): void {
  const gwConnId = ctx.do.getGatewayConnectionId()
  for (const conn of ctx.getConnections()) {
    if (conn.id === gwConnId) continue // Skip gateway connection
    try {
      conn.send(data)
    } catch (err) {
      let frameType = 'unparseable'
      let collection: string | undefined
      try {
        const parsed = JSON.parse(data) as { type?: unknown; collection?: unknown }
        frameType = typeof parsed.type === 'string' ? parsed.type : 'unknown'
        if (frameType === 'synced-collection-delta' && typeof parsed.collection === 'string') {
          collection = parsed.collection
        }
      } catch {
        frameType = 'unparseable'
      }
      console.warn(
        `[SessionDO:${ctx.ctx.id}] broadcast drop sessionId=${ctx.do.name} connId=${conn.id} frameType=${frameType}${
          collection ? ` collection=${collection}` : ''
        } messageSeq=${ctx.do.messageSeq}`,
        err,
      )
    }
  }
}

/**
 * Wrap a `GatewayEvent` in `{type:'gateway_event', event}` and broadcast
 * to every browser connection.
 */
export function broadcastGatewayEvent(ctx: SessionDOContext, event: GatewayEvent): void {
  broadcastToClients(ctx, JSON.stringify({ type: 'gateway_event', event }))
}

/**
 * Send raw stringified payload to a specific client connection (skips the
 * gateway connection). Silent drop if the connection has already closed.
 */
export function sendToClient(ctx: SessionDOContext, connectionId: string, data: string): void {
  const gwConnId = ctx.do.getGatewayConnectionId()
  for (const conn of ctx.getConnections()) {
    if (conn.id === gwConnId) continue
    if (conn.id !== connectionId) continue
    try {
      conn.send(data)
    } catch {
      // Connection already closed — drop silently
    }
    return
  }
}

/**
 * Persist the current `messageSeq` to `session_meta`. Called unconditionally
 * from `broadcastMessages` / `broadcastBranchInfo` after incrementing
 * `ctx.do.messageSeq` (GH#69 B4 — unconditional to eliminate hibernation-
 * rewind risk). Fire-and-forget per the liveness-signal contract: a SQLite
 * write failure must not crash the broadcast pipeline.
 */
export function persistMessageSeq(ctx: SessionDOContext): void {
  try {
    ctx.sql.exec(
      `UPDATE session_meta SET message_seq = ?, updated_at = ? WHERE id = 1`,
      ctx.do.messageSeq,
      Date.now(),
    )
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to persist message_seq to SQLite:`, err)
  }
}

/**
 * Broadcast a messages `SyncedCollectionFrame` (GH#38 P1.2). Every row
 * becomes one `{type:'insert', value: SessionMessage}` op — TanStack DB's
 * key-based upsert dedupes so insert-on-existing-id updates in place, no
 * need to discriminate insert-vs-update at emit time.
 *
 * For rewind / resubmit / branch-navigate (P1.4), callers pass a
 * pre-built ops array via `{ ops }` so delete ops can be emitted
 * alongside inserts in the same frame.
 *
 * `targetClientId` keeps its pre-existing semantics: targeted sends do
 * NOT advance `messageSeq` (the envelope counter echoes the current
 * value) so non-recipients stay aligned with the shared stream.
 */
export function broadcastMessages(
  ctx: SessionDOContext,
  rowsOrOps: WireSessionMessage[] | { ops: SyncedCollectionOp<WireSessionMessage>[] },
  opts: { targetClientId?: string } = {},
): void {
  const rawOps: SyncedCollectionOp<WireSessionMessage>[] = Array.isArray(rowsOrOps)
    ? rowsOrOps.map((r) => ({ type: 'insert' as const, value: r }))
    : rowsOrOps.ops
  if (rawOps.length === 0) return

  // v13: stamp `modifiedAt` on every insert/update wire value that doesn't
  // already carry one. The replay path (replayMessagesFromCursor) pre-
  // stamps values from the SQL `modified_at` column; all other live and
  // snapshot paths land here unstamped. Using `new Date().toISOString()`
  // at emit time keeps the invariant `T_wire >= T_sql` — the SQL UPDATEs
  // in safeAppendMessage / safeUpdateMessage run sequentially before the
  // broadcast, so a client cursor advanced to T_wire can never cause the
  // same row to re-qualify on the next subscribe:messages.
  const now = new Date().toISOString()

  if (!opts.targetClientId) {
    ctx.do.messageSeq += 1
    persistMessageSeq(ctx)
  }

  // Stamp `seq` on every outbound row. Used by gap-detection on the
  // client (messageSeq tiebreaker). Targeted sends don't bump
  // `messageSeq`, so they echo the current value.
  const rowSeq = ctx.do.messageSeq
  const ops: SyncedCollectionOp<WireSessionMessage>[] = rawOps.map((op) => {
    if (op.type === 'delete') return op
    const value = op.value
    if (!value || typeof value !== 'object') return op
    const next: WireSessionMessage = { ...value, seq: rowSeq }
    if (!next.modifiedAt) next.modifiedAt = now
    return { ...op, value: next }
  })
  const frame: SyncedCollectionFrame<WireSessionMessage> = {
    type: 'synced-collection-delta',
    collection: `messages:${ctx.do.name}`,
    ops,
    messageSeq: ctx.do.messageSeq,
    // DO-authoritative status: stamped on every session-scoped frame so
    // the client reads it directly — no derivation fold, no D1 tiebreaker.
    sessionStatus: ctx.state.status,
    // GH#75: targeted sends (cursor-replay, requestSnapshot reply)
    // bypass client gap-gating. Clients install `lastSeq = max(lastSeq,
    // messageSeq)` after applying and apply ops even when the current
    // watermark is ahead.
    ...(opts.targetClientId ? { targeted: true as const } : {}),
  }
  const data = JSON.stringify(frame)
  if (opts.targetClientId) {
    sendToClient(ctx, opts.targetClientId, data)
  } else {
    broadcastToClients(ctx, data)
  }
}

/**
 * Broadcast a branchInfo `SyncedCollectionFrame` (GH#38 P1.5 / B15).
 * Emitted as a sibling frame alongside the messages frame on the same
 * DO turn — React 18 auto-batching delivers both deltas in a single
 * commit (B10 atomicity).
 *
 * Targeted sends (onConnect replay) do NOT advance `messageSeq`; the
 * envelope echoes the current value so non-recipients stay aligned.
 */
export function broadcastBranchInfo(
  ctx: SessionDOContext,
  rows: BranchInfoRow[],
  opts: { targetClientId?: string } = {},
): void {
  if (rows.length === 0 && !opts.targetClientId) return
  if (!opts.targetClientId) {
    ctx.do.messageSeq += 1
    persistMessageSeq(ctx)
  }
  const ops: SyncedCollectionOp<BranchInfoRow>[] = rows.map((value) => ({
    type: 'insert' as const,
    value,
  }))
  const frame: SyncedCollectionFrame<BranchInfoRow> = {
    type: 'synced-collection-delta',
    collection: `branchInfo:${ctx.do.name}`,
    ops,
    messageSeq: ctx.do.messageSeq,
    sessionStatus: ctx.state.status,
    ...(opts.targetClientId ? { targeted: true as const } : {}),
  }
  const data = JSON.stringify(frame)
  if (opts.targetClientId) {
    sendToClient(ctx, opts.targetClientId, data)
  } else {
    broadcastToClients(ctx, data)
  }
}

/**
 * Push a status-only frame to all connected clients. Carries zero ops —
 * the client extracts `sessionStatus` and writes it to the local status
 * store. Called from `updateState` whenever the status field changes, so
 * the client sees every transition immediately — even when no message
 * broadcast coincides with the change.
 *
 * Does NOT bump `messageSeq` (no payload ⇒ no gap-check concern), so
 * the client's seq-tracking is unperturbed.
 */
export function broadcastStatusFrame(ctx: SessionDOContext): void {
  const frame: SyncedCollectionFrame<WireSessionMessage> = {
    type: 'synced-collection-delta',
    collection: `messages:${ctx.do.name}`,
    ops: [],
    messageSeq: ctx.do.messageSeq,
    sessionStatus: ctx.state.status,
  }
  broadcastToClients(ctx, JSON.stringify(frame))
}

/**
 * Push status to the session owner's user-stream (via UserSettingsDO)
 * so background sessions (sidebar, tab bar) see transitions without a
 * per-session WS connection. Uses the lightweight `session_status`
 * collection — `{id, status}` only, no D1 read/write. Fire-and-forget.
 */
export function broadcastStatusToOwner(ctx: SessionDOContext): void {
  const userId = ctx.state.userId
  if (!userId) return
  ctx.ctx.waitUntil(
    broadcastSyncedDelta(ctx.env, userId, 'session_status', [
      { type: 'update', value: { id: ctx.do.name, status: ctx.state.status } },
    ]),
  )
}

/**
 * Rebuild the ArcSummary for the session's parent arc and broadcast
 * the delta op to the owning user's UserSettingsDO. Fire-and-forget
 * via `waitUntil` so the D1 read → rebuild → broadcast latency does
 * not stack on the caller.
 *
 * GH#116 P1.3: replaces `broadcastChainUpdate(ctx, issueNumber)`. The
 * arcId lives on the D1 `agent_sessions.arc_id` column (SessionMeta
 * does not carry arcId — see `advance-arc.ts` for the same lookup
 * pattern). When the lookup misses (orphan session, mid-migration row,
 * arcId=null) the broadcast no-ops.
 */
export function broadcastArcUpdate(ctx: SessionDOContext): void {
  const userId = ctx.state.userId
  if (!userId) return

  ctx.ctx.waitUntil(
    (async () => {
      try {
        const sessionId = ctx.do.name
        const rows = await ctx.do.d1
          .select({ arcId: agentSessions.arcId })
          .from(agentSessions)
          .where(eq(agentSessions.id, sessionId))
          .limit(1)
        const arcId = rows[0]?.arcId
        if (!arcId) return

        const row = await buildArcRow(ctx.env, ctx.do.d1, userId, arcId)
        if (row) {
          await broadcastSyncedDelta(ctx.env, userId, 'arcs', [{ type: 'update', value: row }])
        } else {
          await broadcastSyncedDelta(ctx.env, userId, 'arcs', [{ type: 'delete', key: arcId }])
        }
      } catch (err) {
        console.error(`[SessionDO:${ctx.ctx.id}] broadcastArcUpdate failed:`, err)
      }
    })(),
  )
}

/**
 * @deprecated GH#116 P1.3 transitional alias for the rename
 * `broadcastChainUpdate` → `broadcastArcUpdate`. Call sites in this
 * package have been swept; this re-export keeps any in-flight branch
 * code or out-of-tree imports compiling. Remove in P5.
 */
export const broadcastChainUpdate = (ctx: SessionDOContext, _issueNumber: number | null): void => {
  // The legacy signature took an issueNumber; the new helper derives
  // the arcId from the session row directly. We intentionally ignore
  // the legacy argument so call sites can pass it through unchanged
  // until they are updated.
  void _issueNumber
  broadcastArcUpdate(ctx)
}
