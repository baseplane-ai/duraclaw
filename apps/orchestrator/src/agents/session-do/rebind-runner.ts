import type { SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { contentToParts } from '~/lib/message-parts'
import type { ContentBlock } from '~/lib/types'
import {
  buildAwaitingPart,
  computeBranchInfoForUserTurn,
  serializeHistoryForFork,
} from './branches'
import { broadcastBranchInfo, broadcastMessages } from './broadcast'
import { bumpTurnCounter, persistTurnState, safeAppendMessage } from './history'
import { triggerGatewayDial } from './runner-link'
import { updateState } from './status'
import type { SessionDOContext } from './types'

/**
 * Spec #116 B8: orphan-recovery primitive.
 *
 * Replaces the `forkWithHistoryImpl` orphan-recovery path that
 * `sendMessageImpl` calls when its preflight finds the gateway holds a
 * runner with our `runner_session_id` (i.e. an orphaned runner whose
 * dial-back has gone silent). The DO clears `runner_session_id`,
 * appends the new user turn to local history, wraps the full local
 * transcript in `<prior_conversation>...</prior_conversation>`, and
 * triggers a fresh `execute` dial — same DO, same sessions row id,
 * brand-new runner_session_id (no `hasLiveResume` collision).
 *
 * The `<prior_conversation>` template, the `nextText` extraction, and
 * the `safeAppendMessage` -> `persistTurnState` -> `broadcastMessages`
 * -> branch-info-piggyback sequence all match today's
 * `forkWithHistoryImpl` byte-for-byte; the only difference is the
 * scope (orphan recovery only, no `worktreeId` rebind).
 */
export async function rebindRunnerImpl(
  ctx: SessionDOContext,
  args: { nextUserMessage?: string | ContentBlock[] },
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.state.project) {
    return { ok: false, error: 'Session has no project — cannot rebind runner.' }
  }

  // Build a compact transcript from local history (safe to read even when
  // the DO has lost WS contact with its session-runner).
  const transcript = serializeHistoryForFork(ctx)

  const content = args.nextUserMessage
  const nextText =
    typeof content === 'string'
      ? content
      : content
        ? content
            .map((b) => {
              const bl = b as { type?: string; text?: string }
              return bl.type === 'text' ? (bl.text ?? '') : ''
            })
            .filter(Boolean)
            .join('\n')
        : ''

  const wrappedPrompt = transcript
    ? `<prior_conversation>\n${transcript}\n</prior_conversation>\n\nContinuing the conversation above. New user message follows.\n\n${nextText}`
    : nextText

  // Persist the user's new message in local history exactly as sendMessage
  // would, so the UI reflects the turn boundary. We do NOT persist the
  // transcript prefix — that's only for the SDK's fresh context.
  if (content !== undefined) {
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
      console.error(`[SessionDO:${ctx.ctx.id}] rebindRunner: persist user msg failed:`, err)
    }
  }

  // Spec #80 B3: drop the old runner_session_id so the new runner gets a
  // brand-new one (guarantees no hasLiveResume collision with the
  // orphan) and flip status to 'pending' while we wait for the dial.
  updateState(ctx, {
    status: 'pending',
    error: null,
    runner_session_id: null,
  })

  void triggerGatewayDial(ctx, {
    type: 'execute',
    project: ctx.state.project,
    prompt: wrappedPrompt,
  })

  return { ok: true }
}
