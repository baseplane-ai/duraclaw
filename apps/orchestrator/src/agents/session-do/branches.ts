import type { BranchInfoRow, SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import type { AwaitingReason, AwaitingResponsePart } from '~/lib/awaiting-response'
import { chunkOps } from '~/lib/chunk-frame'
import { contentToParts } from '~/lib/message-parts'
import type { ContentBlock } from '~/lib/types'
import { finalizeStreamingParts } from '../gateway-event-mapper'
import { broadcastBranchInfo, broadcastMessages } from './broadcast'
import {
  bumpTurnCounter,
  deriveSnapshotOps,
  persistTurnState,
  safeAppendMessage,
  safeUpdateMessage,
} from './history'
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
 * Build a compact transcript of the current local history for use as a
 * SDK prompt prefix in `forkWithHistory`. Pure — does not touch state.
 */
export function serializeHistoryForFork(ctx: SessionDOContext): string {
  const history = ctx.session.getHistory()
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
 * Body of the `@callable rewind` RPC. Sends a rewind GatewayCommand to
 * the runner, then DO-authors a snapshot of the trimmed history so all
 * connected clients converge without a gateway round-trip.
 */
export async function rewindImpl(
  ctx: SessionDOContext,
  messageId: string,
): Promise<{ ok: boolean; error?: string }> {
  sendToGateway(ctx, {
    type: 'rewind',
    session_id: ctx.state.session_id ?? '',
    message_id: messageId,
  })
  // DO-authored snapshot (B2): broadcast the trimmed history so all clients
  // converge on the post-rewind view without round-tripping through gateway.
  try {
    const history = ctx.session.getHistory()
    const idx = history.findIndex((m) => m.id === messageId)
    const trimmed = idx >= 0 ? history.slice(0, idx + 1) : history
    // GH#38 P1.4: emit SyncedCollectionFrame on the new messages wire.
    // staleIds = rows present in current default leaf but NOT in trimmed.
    const { ops } = deriveSnapshotOps<WireSessionMessage>({
      oldLeaf: history as unknown as WireSessionMessage[],
      newLeaf: trimmed as unknown as WireSessionMessage[],
    })
    for (const chunk of chunkOps(ops)) {
      broadcastMessages(ctx, { ops: chunk })
    }
    // GH#38 P1.5 / B15: emit sibling branchInfo frame on the same DO
    // turn. B10: React 18 auto-batches both deltas into a single commit.
    broadcastBranchInfo(ctx, computeBranchInfo(ctx, trimmed))
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to broadcast rewind snapshot:`, err)
  }
  return { ok: true }
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
    sendToGateway(ctx, { type: 'abort', session_id: ctx.state.session_id ?? '' })
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
    sdk_session_id: ctx.state.sdk_session_id ?? '',
  })

  return { ok: true, leafId: newUserMsgId }
}

/**
 * Body of the `@callable forkWithHistory` RPC. Spawns a fresh SDK
 * session (new sdk_session_id) seeded with a transcript of the prior
 * conversation. Feels like a resume from the user's POV but sidesteps
 * SDK `resume` entirely — useful when the prior sdk_session_id is
 * orphaned by a stuck session-runner, unresumable, or we just want a
 * clean context window without losing the thread.
 */
export async function forkWithHistoryImpl(
  ctx: SessionDOContext,
  content: string | ContentBlock[],
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.state.project) {
    return { ok: false, error: 'Session has no project — cannot fork.' }
  }

  // Build a compact transcript from local history (safe to read even when
  // the DO has lost WS contact with its session-runner).
  const transcript = serializeHistoryForFork(ctx)

  const nextText =
    typeof content === 'string'
      ? content
      : content
          .map((b) => {
            const bl = b as { type?: string; text?: string }
            return bl.type === 'text' ? (bl.text ?? '') : ''
          })
          .filter(Boolean)
          .join('\n')

  const forkedPrompt = transcript
    ? `<prior_conversation>\n${transcript}\n</prior_conversation>\n\nContinuing the conversation above. New user message follows.\n\n${nextText}`
    : nextText

  // Persist the user's new message in local history exactly as sendMessage
  // would, so the UI reflects the turn boundary. We do NOT persist the
  // transcript prefix — that's only for the SDK's fresh context.
  const turnId = bumpTurnCounter(ctx)
  const userMsgId = `usr-${turnId}`
  const userMsg: SessionMessage & { canonical_turn_id?: string } = {
    id: userMsgId,
    role: 'user',
    parts: [...contentToParts(content), buildAwaitingPart('first_token')],
    createdAt: new Date(),
    canonical_turn_id: userMsgId,
  }
  try {
    await safeAppendMessage(ctx, userMsg)
    persistTurnState(ctx)
    // GH#38 P1.5 / B10: emit messages + branchInfo siblings back-to-back.
    broadcastMessages(ctx, [userMsg as unknown as WireSessionMessage])
    const siblingRow = computeBranchInfoForUserTurn(ctx, userMsg)
    if (siblingRow) {
      broadcastBranchInfo(ctx, [siblingRow])
    }
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] forkWithHistory: persist user msg failed:`, err)
  }

  // Spec #80 B3: drop the old sdk_session_id so the new runner gets a
  // brand-new one (guarantees no hasLiveResume collision with any
  // orphan) and flip status to 'pending' while we wait for the dial.
  updateState(ctx, {
    status: 'pending',
    error: null,
    sdk_session_id: null,
  })

  void triggerGatewayDial(ctx, {
    type: 'execute',
    project: ctx.state.project,
    prompt: forkedPrompt,
  })

  return { ok: true }
}
