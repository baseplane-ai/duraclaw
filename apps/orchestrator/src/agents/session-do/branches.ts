import type { BranchInfoRow, SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { eq } from 'drizzle-orm'
import { agentSessions } from '~/db/schema'
import type { AwaitingReason, AwaitingResponsePart } from '~/lib/awaiting-response'
import { chunkOps } from '~/lib/chunk-frame'
import { contentToParts } from '~/lib/message-parts'
import { bindWorktreeById } from '~/lib/reserve-worktree'
import type { ContentBlock } from '~/lib/types'
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
 * Body of the `@callable forkWithHistory` RPC. Spec #101 P1.2 B10:
 * transcript-agnostic — works for any adapter that accepts a prompt. The
 * spawned runner gets a fresh adapter session (new `runner_session_id`)
 * seeded with a serialized transcript of the prior conversation. Feels
 * like a resume from the user's POV but sidesteps adapter-native resume
 * entirely — useful when the prior `runner_session_id` is orphaned by a
 * stuck runner, unresumable, or we just want a clean context window
 * without losing the thread.
 */
export async function forkWithHistoryImpl(
  ctx: SessionDOContext,
  content: string | ContentBlock[],
  opts?: { worktreeId?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.state.project) {
    return { ok: false, error: 'Session has no project — cannot fork.' }
  }

  // GH#115 P1.5 / B-FORK-1: optional worktreeId override. Default
  // inherits the parent's `ctx.state.worktreeId` (no-op — same DO,
  // same session). When the caller passes an explicit id different
  // from the current one, validate via `bindWorktreeById` against
  // `{kind:'session', id:<doId>}` (fork-with-history doesn't carry
  // kataIssue) and re-stamp `project_path` so the next gateway dial
  // routes the runner into the new clone. On 409 / 404 we return
  // early — the fork is not attempted.
  if (opts?.worktreeId && opts.worktreeId !== ctx.state.worktreeId) {
    const ownerUserId = ctx.state.userId
    if (!ownerUserId) {
      return { ok: false, error: 'Cannot rebind worktree without authenticated owner.' }
    }
    const sessionIdStr = ctx.ctx.id.toString()
    const bindResult = await bindWorktreeById(
      ctx.do.d1,
      opts.worktreeId,
      { kind: 'session', id: sessionIdStr },
      ownerUserId,
    )
    if (!bindResult.ok) {
      if (bindResult.kind === 'not_found') {
        return { ok: false, error: `Worktree ${opts.worktreeId} not found.` }
      }
      const existing = bindResult.existing
      return {
        ok: false,
        error: `Worktree ${opts.worktreeId} held by ${existing.reservedBy?.kind ?? '?'}:${existing.reservedBy?.id ?? '?'}.`,
      }
    }
    updateState(ctx, {
      worktreeId: bindResult.row.id,
      project_path: bindResult.row.path,
    })
    // Also persist the new worktreeId on the D1 agent_sessions row so
    // the chain projection + sessions list stays consistent.
    try {
      await ctx.do.d1
        .update(agentSessions)
        .set({ worktreeId: bindResult.row.id, updatedAt: new Date().toISOString() })
        .where(eq(agentSessions.id, sessionIdStr))
    } catch (err) {
      console.error(`[SessionDO:${ctx.ctx.id}] forkWithHistory: D1 worktreeId update failed:`, err)
    }
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

  // Spec #80 B3: drop the old runner_session_id so the new runner gets a
  // brand-new one (guarantees no hasLiveResume collision with any
  // orphan) and flip status to 'pending' while we wait for the dial.
  updateState(ctx, {
    status: 'pending',
    error: null,
    runner_session_id: null,
  })

  void triggerGatewayDial(ctx, {
    type: 'execute',
    project: ctx.state.project,
    prompt: forkedPrompt,
  })

  return { ok: true }
}
