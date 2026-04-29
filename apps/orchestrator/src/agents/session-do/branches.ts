import type { BranchInfoRow, SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { and, eq } from 'drizzle-orm'
import { agentSessions, arcs } from '~/db/schema'
import type { AwaitingReason, AwaitingResponsePart } from '~/lib/awaiting-response'
import { chunkOps } from '~/lib/chunk-frame'
import { createSession } from '~/lib/create-session'
import { broadcastBranchInfo, broadcastMessages } from './broadcast'
import {
  bumpTurnCounter,
  deriveSnapshotOps,
  persistTurnState,
  safeAppendMessage,
  safeUpdateMessage,
} from './history'
import { finalizeStreamingParts } from './message-parts'
import { sendToGateway, triggerGatewayDial } from './runner-link'
import { updateState } from './status'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 4: branches extraction.
 *
 * Owns DO-authored branch operations: rewind / resubmit / fork-with-history,
 * plus the branch-info computation helpers that piggyback on every user-turn
 * delta (GH#14 P3 / GH#38 P1.5).
 *
 * `@callable()` decorators stay on the class methods in `index.ts`; the
 * wrappers delegate to these `*Impl` free functions. Decorators don't work
 * on standalone functions (Implementation Hints gotcha #4).
 */

/**
 * Spec #80 B10: stamp-helper used at every turn-entry point so the
 * awaiting-response part shape is identical across all four call sites
 * (sendMessage / spawn / forkWithHistory / resubmitMessage).
 */
export function buildAwaitingPart(reason: AwaitingReason = 'first_token'): AwaitingResponsePart {
  return { type: 'awaiting_response', state: 'pending', reason, startedTs: Date.now() }
}

/**
 * Compute branchInfo rows for every user message in `history` whose
 * parent has >1 user-role siblings. Used by snapshot broadcasts
 * (rewind / resubmit / branch-navigate / requestSnapshot).
 *
 * Walks the supplied history in order; each user message looks up its
 * parent's siblings via `session.getBranches(parentId)` and emits a row
 * only when the parent has multiple user-role children. Single-child
 * parents are skipped to keep the payload small.
 */
export function computeBranchInfo(
  ctx: SessionDOContext,
  history: SessionMessage[],
): BranchInfoRow[] {
  const rows: BranchInfoRow[] = []
  const nowIso = new Date().toISOString()
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (msg.role !== 'user') continue
    const parentId = i > 0 ? history[i - 1].id : null
    if (!parentId) continue
    try {
      const branches = ctx.session.getBranches(parentId)
      const siblings = branches.filter((m) => m.role === 'user').map((m) => m.id)
      if (siblings.length <= 1) continue
      rows.push({
        parentMsgId: parentId,
        sessionId: ctx.do.name,
        siblings,
        activeId: msg.id,
        updatedAt: nowIso,
      })
    } catch {
      // Skip on error — branches may be unresolvable if the Session is
      // mid-mutation; the next snapshot will recompute.
    }
  }
  return rows
}

/**
 * Compute a single BranchInfoRow for the parent of `msg` if that parent now
 * has >1 siblings. Returns `undefined` if no parent or no siblings. Used by
 * sendMessage / forkWithHistory / resubmitMessage to piggyback branch-info
 * onto the user-turn delta (P2 B2).
 */
export function computeBranchInfoForUserTurn(
  ctx: SessionDOContext,
  msg: SessionMessage,
): BranchInfoRow | undefined {
  try {
    // GH#57: replaced getHistory() (O(N) recursive CTE + all BLOBs) with
    // a targeted parent_id lookup. The old call loaded ~25MB for a 500-msg
    // session on every sendMessage, just to find the parent of the new msg.
    const rows = ctx.do.sql<{ parent_id: string | null }>`
      SELECT parent_id FROM assistant_messages
      WHERE id = ${msg.id} AND session_id = ''
      LIMIT 1
    `
    const parentId = rows[0]?.parent_id
    if (!parentId) return undefined
    const branches = ctx.session.getBranches(parentId)
    const siblings = branches.filter((m) => m.role === 'user').map((m) => m.id)
    if (siblings.length <= 1) return undefined
    return {
      parentMsgId: parentId,
      sessionId: ctx.do.name,
      siblings,
      activeId: msg.id,
      updatedAt: new Date().toISOString(),
    }
  } catch {
    return undefined
  }
}

/**
 * Build a compact transcript of the current local history for use as an
 * SDK prompt prefix. Pure — does not touch state.
 *
 * GH#116: `maxSeq` (optional) caps the transcript at the first
 * `maxSeq` messages of the linear history. Used by `branchArcImpl`
 * to fork from a partial transcript (B7). When omitted, the full
 * local history is serialized (used by `rebindRunnerImpl`'s orphan
 * recovery path).
 */
export function serializeHistoryForFork(ctx: SessionDOContext, maxSeq?: number): string {
  const fullHistory = ctx.session.getHistory()
  const history =
    typeof maxSeq === 'number' && maxSeq >= 0 && maxSeq < fullHistory.length
      ? fullHistory.slice(0, maxSeq)
      : fullHistory
  return history
    .map((m) => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role
      const text = m.parts
        .map((p) => {
          if (p.type === 'text') return p.text ?? ''
          if (p.type === 'reasoning') return `[thinking] ${p.text ?? ''}`
          if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
            const name = (p as { toolName?: string }).toolName ?? p.type.slice(5)
            return `[used tool: ${name}]`
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return text ? `${role}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Body of the `@callable resubmitMessage` RPC. Aborts any in-flight turn,
 * appends the new user message as a sibling branch off the original
 * message's parent, broadcasts a snapshot for the new branch leaf, then
 * triggers a `resume` dial to the runner.
 */
export async function resubmitMessageImpl(
  ctx: SessionDOContext,
  originalMessageId: string,
  newContent: string,
): Promise<{ ok: boolean; leafId?: string; error?: string }> {
  // 1. If streaming in progress, abort first
  if (ctx.do.currentTurnMessageId) {
    sendToGateway(ctx, { type: 'stop', session_id: ctx.state.session_id ?? '' })
    // Finalize orphaned streaming parts
    const existing = ctx.session.getMessage(ctx.do.currentTurnMessageId)
    if (existing) {
      const finalizedParts = finalizeStreamingParts(existing.parts)
      safeUpdateMessage(ctx, { ...existing, parts: finalizedParts })
    }
    ctx.do.currentTurnMessageId = null
  }

  // 2. Find the parent of the original message
  const originalMsg = ctx.session.getMessage(originalMessageId)
  if (!originalMsg) {
    return { ok: false, error: 'Original message not found' }
  }

  // Get history to find parent: the message before originalMessageId in the path
  const history = ctx.session.getHistory(originalMessageId)
  const origIdx = history.findIndex((m) => m.id === originalMessageId)
  const parentId = origIdx > 0 ? history[origIdx - 1].id : null

  // 3. Create new user message as sibling branch
  const turnId = bumpTurnCounter(ctx)
  const newUserMsgId = `usr-${turnId}`
  const newUserMsg: SessionMessage & { canonical_turn_id?: string } = {
    id: newUserMsgId,
    role: 'user',
    parts: [{ type: 'text', text: newContent }, buildAwaitingPart('first_token')],
    createdAt: new Date(),
    canonical_turn_id: newUserMsgId,
  }

  try {
    safeAppendMessage(ctx, newUserMsg, parentId)
    persistTurnState(ctx)
    broadcastMessages(ctx, [newUserMsg as unknown as WireSessionMessage])
    // DO-authored snapshot (B2): broadcast the branch view so all clients
    // realign onto the new leaf. getHistory(leafId) returns the path ending
    // at newUserMsg.id.
    const oldLeafHistory = ctx.session.getHistory(originalMessageId)
    const resubmitHistory = ctx.session.getHistory(newUserMsg.id)
    // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
    // staleIds = rows on the oldLeaf path (ending at originalMessageId)
    // but NOT on the newLeaf path — typically [originalMessageId] since
    // the sibling branches share a prefix up to `parentId`.
    const { ops } = deriveSnapshotOps<WireSessionMessage>({
      oldLeaf: oldLeafHistory as unknown as WireSessionMessage[],
      newLeaf: resubmitHistory as unknown as WireSessionMessage[],
    })
    for (const chunk of chunkOps(ops)) {
      broadcastMessages(ctx, { ops: chunk })
    }
    // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO turn.
    broadcastBranchInfo(ctx, computeBranchInfo(ctx, resubmitHistory))
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to create branch:`, err)
    return { ok: false, error: 'Failed to create branch' }
  }

  // 4. Send to gateway for execution
  // Spec #80 B4: flip status to 'pending' while we wait for the dial.
  updateState(ctx, { status: 'pending', error: null })
  void triggerGatewayDial(ctx, {
    type: 'resume',
    project: ctx.state.project,
    prompt: newContent,
    runner_session_id: ctx.state.runner_session_id ?? '',
  })

  return { ok: true, leafId: newUserMsgId }
}

/**
 * Body of the `@callable branchArc` RPC (GH#116 B7). Creates a child arc
 * under the current session's parent arc, seeded with a transcript-
 * wrapped prompt containing the parent session's history (optionally
 * truncated at `fromMessageSeq`) and a fresh user message. The new arc
 * inherits `externalRef` from the parent by default and points back via
 * `parentArcId`. Returns both the new arc id and the new session id; the
 * UI wires both into a "branch tree" view under the parent arc.
 *
 * Replaces the intentional path of the legacy `forkWithHistoryImpl`.
 * The orphan-recovery path (formerly the same function's other use) is
 * now `rebindRunnerImpl` — separate concern, separate file.
 */
export async function branchArcImpl(
  ctx: SessionDOContext,
  args: { fromMessageSeq?: number; prompt: string; mode?: string | null; title?: string },
): Promise<{ ok: boolean; newArcId?: string; newSessionId?: string; error?: string }> {
  // ── Validation ──────────────────────────────────────────────────────
  const trimmedPrompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!trimmedPrompt) {
    return { ok: false, error: 'prompt required' }
  }

  if (args.fromMessageSeq !== undefined) {
    if (!Number.isInteger(args.fromMessageSeq) || args.fromMessageSeq < 0) {
      return { ok: false, error: 'invalid fromMessageSeq' }
    }
    const historyLen = ctx.session.getHistory().length
    if (args.fromMessageSeq > historyLen) {
      return { ok: false, error: 'invalid fromMessageSeq' }
    }
  }

  if (!ctx.state.project) {
    return { ok: false, error: 'Session has no project — cannot branch.' }
  }

  const userId = ctx.state.userId
  if (!userId) {
    return { ok: false, error: 'Cannot branch without authenticated owner.' }
  }

  const sessionId = ctx.ctx.id.toString()

  // ── Resolve parent arc via D1 ───────────────────────────────────────
  // SessionMeta does not carry `arcId` directly; the arc parent is
  // recorded on the agent_sessions D1 row. Read it (plus the parent
  // arc's title + externalRef) so the new arc inherits sensibly.
  let parentArcId: string
  let parentArcTitle: string
  let parentArcExternalRef: string | null
  try {
    const rows = await ctx.do.d1
      .select({
        arcId: agentSessions.arcId,
        arcTitle: arcs.title,
        arcExternalRef: arcs.externalRef,
      })
      .from(agentSessions)
      .innerJoin(arcs, eq(agentSessions.arcId, arcs.id))
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
      .limit(1)
    const row = rows[0]
    if (!row?.arcId) {
      return { ok: false, error: 'Parent arc not found for this session.' }
    }
    parentArcId = row.arcId
    parentArcTitle = row.arcTitle
    parentArcExternalRef = row.arcExternalRef ?? null
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] branchArc: parent arc lookup failed:`, err)
    return { ok: false, error: 'Failed to resolve parent arc.' }
  }

  // ── Build wrapped prompt ────────────────────────────────────────────
  // Matches `forkWithHistoryImpl`'s template verbatim (per spec B7) so
  // the model sees an identical prefix shape.
  const transcript = serializeHistoryForFork(ctx, args.fromMessageSeq)
  const wrappedPrompt = transcript
    ? `<prior_conversation>\n${transcript}\n</prior_conversation>\n\nContinuing the conversation above. New user message follows.\n\n${args.prompt}`
    : args.prompt

  // ── Insert child arc row ────────────────────────────────────────────
  const newArcId = `arc_${crypto.randomUUID()}`
  const now = new Date().toISOString()
  const newArcTitle = args.title ?? `${parentArcTitle} — side arc`
  try {
    await ctx.do.d1.insert(arcs).values({
      id: newArcId,
      userId,
      title: newArcTitle,
      // Inherit parent externalRef by default (GH issue ref carries
      // through). Stored as the parent's raw JSON text — round-trips
      // cleanly via parseExternalRef on read.
      externalRef: parentArcExternalRef,
      status: 'open',
      parentArcId,
      createdAt: now,
      updatedAt: now,
    })
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] branchArc: child arc insert failed:`, err)
    return { ok: false, error: 'Failed to create child arc.' }
  }

  // ── Spawn the new arc's first session ───────────────────────────────
  // Inline-await shim for the broadcastSessionRow waitUntil — branchArc
  // is invoked from inside a DO RPC where ctx.ctx.waitUntil is owned by
  // the inbound HTTP/WS request; chaining onto it from a deeply-nested
  // callsite is fragile, and the broadcast is best-effort.
  const spawnCtx = {
    waitUntil: (p: Promise<unknown>) => {
      void p.catch((err) =>
        console.warn(`[SessionDO:${ctx.ctx.id}] branchArc: broadcast failed`, err),
      )
    },
  }
  // GH#116 B7: thread `mode` and `parentSessionId` through so the new
  // arc's first session row carries (a) the optional kata mode the
  // branch starts in and (b) a back-pointer to the parent session in
  // the parent arc. The branch lineage walks parentSessionId across the
  // arc boundary; arc-tree views resolve via `arcs.parentArcId`.
  const result = await createSession(
    ctx.env,
    userId,
    {
      arcId: newArcId,
      project: ctx.state.project,
      prompt: wrappedPrompt,
      agent: 'claude',
      mode: args.mode ?? null,
      parentSessionId: sessionId,
    },
    spawnCtx,
  )
  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  return { ok: true, newArcId, newSessionId: result.sessionId }
}
