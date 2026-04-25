import type { SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { contentToParts } from '~/lib/message-parts'
import type { ContentBlock } from '~/lib/types'
import { listSessions } from '~/lib/vps-client'
import {
  buildAwaitingPart as buildAwaitingPartImpl,
  computeBranchInfoForUserTurn as computeBranchInfoForUserTurnImpl,
  forkWithHistoryImpl,
} from './branches'
import {
  broadcastBranchInfo as broadcastBranchInfoImpl,
  broadcastMessages as broadcastMessagesImpl,
} from './broadcast'
import { claimSubmitId } from './history'
import { sendToGateway, triggerGatewayDial as triggerGatewayDialImpl } from './runner-link'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted body of `SessionDO.sendMessage(...)`.
 *
 * Idempotency, orphan auto-fork, status auto-heal, and the dispatch
 * decision (live runner → stream-input vs idle+runner_session_id → resume)
 * all live here. The DO-class shim is a single `return sendMessageImpl(...)`.
 */

export interface SendMessageOpts {
  submitId?: string
  client_message_id?: string
  createdAt?: string
  // Spec #68 B14 — accepted for forward-compat when shared sessions need to
  // attribute turns to the sender. The column exists on the SDK-owned
  // `assistant_messages` table (migration v11) but message persistence flows
  // through `Session.appendMessage`, not direct SQL, so this is a no-op
  // today. Plumbed now so the wire shape is stable when UI attribution lands.
  senderId?: string
}

export interface SendMessageResult {
  ok: boolean
  error?: string
  recoverable?: 'forkWithHistory'
  duplicate?: boolean
  id?: string
}

export async function sendMessageImpl(
  ctx: SessionDOContext,
  content: string | ContentBlock[],
  opts?: SendMessageOpts,
): Promise<SendMessageResult> {
  // Idempotency: if a submitId was supplied and we've already accepted it,
  // treat this as a duplicate of that prior call and no-op. Rows older than
  // 60s are pruned on each insert to cap table growth.
  if (opts?.submitId !== undefined) {
    const submitId = opts.submitId
    if (typeof submitId !== 'string' || submitId.length === 0 || submitId.length > 64) {
      return { ok: false, error: 'invalid submitId' }
    }
    // The SDK's tagged-template SQL is on the DO instance; bind it through
    // ctx.do so the helper's SqlFn shape lines up with what session-do.ts
    // historically passed.
    const claim = claimSubmitId(
      ctx.do.sql.bind(ctx.do) as unknown as <T>(
        s: TemplateStringsArray,
        ...v: (string | number | boolean | null)[]
      ) => T[],
      submitId,
    )
    if (!claim.ok) {
      return { ok: false, error: claim.error }
    }
    if (claim.duplicate) {
      return { ok: true }
    }
  }

  // GH#38 P1.2: validate optional `createdAt` (ISO 8601). When supplied, the
  // server adopts it verbatim as the row's createdAt so optimistic loopback
  // reconciliation via TanStack DB deepEquals sees identical rows. Invalid
  // ISO → 400-ish error from the RPC.
  if (opts?.createdAt !== undefined) {
    if (typeof opts.createdAt !== 'string' || Number.isNaN(new Date(opts.createdAt).getTime())) {
      return { ok: false, error: 'invalid createdAt' }
    }
  }

  const hasLiveRunner = Boolean(ctx.do.getGatewayConnectionId())

  // Auto-heal a stuck status='running' / 'waiting_gate' with no attached
  // runner: this happens when maybeRecoverAfterGatewayDrop's grace path
  // loses its setTimeout to hibernation and the watchdog alarm hasn't yet
  // run recovery. Without this, the next user turn hits the isResumable
  // gate below and returns "Cannot send message: status is 'running'" —
  // the session is permanently wedged until manual intervention.
  if (!hasLiveRunner && (ctx.state.status === 'running' || ctx.state.status === 'waiting_gate')) {
    console.warn(
      `[SessionDO:${ctx.ctx.id}] sendMessage: auto-healing stuck status='${ctx.state.status}' with no runner — running recovery inline`,
    )
    await ctx.do.recoverFromDroppedConnection()
    // recovery flipped status to 'idle' and preserved runner_session_id;
    // fall through to the resumable path below.
  }

  const { status } = ctx.state
  // A session-runner stays alive through `type=result` and blocks waiting
  // on the next stream-input (see claude-runner.ts multi-turn loop). Route
  // by connection liveness, not by DO status: if the gateway-role WS is
  // still attached, reuse that runner.
  // `'error'` is a terminal-UI state set by `failAwaitingTurn()` (spec
  // #80 B7) but per its own contract "the session remains resumable via
  // runner_session_id" — the next user turn must reopen the resume path,
  // not get wedged behind the gate below.
  const isResumable =
    !hasLiveRunner && (status === 'idle' || status === 'error') && ctx.state.runner_session_id

  if (!hasLiveRunner && !isResumable) {
    return { ok: false, error: `Cannot send message: status is '${status}'` }
  }

  // GH#8 preflight: if we're about to trigger a gateway dial but the
  // gateway-contract env vars are missing, fail loudly BEFORE persisting
  // the user message. Otherwise the message lands in history, the
  // triggerGatewayDial bail flips status to idle, and the user perceives
  // a "silent no-op" with nothing in the transcript to explain it.
  if (!hasLiveRunner && isResumable) {
    if (!ctx.env.CC_GATEWAY_URL || !ctx.env.WORKER_PUBLIC_URL) {
      console.error(
        `[SessionDO:${ctx.ctx.id}] sendMessage preflight: CC_GATEWAY_URL=${Boolean(ctx.env.CC_GATEWAY_URL)} WORKER_PUBLIC_URL=${Boolean(ctx.env.WORKER_PUBLIC_URL)} — gateway not configured`,
      )
      return {
        ok: false,
        error:
          'Gateway not configured for this worker (missing CC_GATEWAY_URL or WORKER_PUBLIC_URL)',
      }
    }
  }

  // If we're about to take the resume path, preflight for an orphan runner
  // that would hijack the runner_session_id. If found, auto-fork to a fresh
  // adapter session so the user doesn't see silent failure.
  if (!hasLiveRunner && isResumable) {
    const sdk = ctx.state.runner_session_id ?? ''
    const gatewayUrl = ctx.env.CC_GATEWAY_URL
    if (gatewayUrl && sdk) {
      try {
        const sessions = await listSessions(gatewayUrl, ctx.env.CC_GATEWAY_SECRET)
        const orphan = sessions.find((s) => s.runner_session_id === sdk && s.state === 'running')
        if (orphan) {
          console.warn(
            `[SessionDO:${ctx.ctx.id}] sendMessage: orphan runner ${orphan.session_id} holds runner_session_id ${sdk} — auto-forking with transcript`,
          )
          return forkWithHistoryImpl(ctx, content)
        }
      } catch (err) {
        // Non-fatal: fall through to the dial attempt. If it then collides
        // the runner will crash and the exit file makes it visible.
        console.warn(`[SessionDO:${ctx.ctx.id}] sendMessage preflight failed:`, err)
      }
    }
  }

  // GH#38 P1.2: duplicate-clientId idempotency. If a client retries the
  // POST after a network hiccup (same `clientId` → same `userMsgId`), the
  // row may already be persisted. Check first and short-circuit — do NOT
  // overwrite, re-broadcast, or re-invoke the SDK.
  const candidateId = opts?.client_message_id ?? `usr-${ctx.do.turnCounter + 1}`
  if (opts?.client_message_id) {
    try {
      // Same SDK-owned `assistant_messages` table the Session class writes
      // to. `session_id` is always the literal empty string in our setup
      // because `Session.create(this)` is called without `.forSession(id)`.
      const existing = [
        ...ctx.sql.exec<{ id: string }>(
          `SELECT id FROM assistant_messages
           WHERE id = ? AND session_id = ''
           LIMIT 1`,
          candidateId,
        ),
      ]
      if (existing.length > 0) {
        return { ok: true, duplicate: true, id: candidateId }
      }
    } catch (err) {
      // Defensive: if the lookup fails (table absent pre-first-append),
      // fall through and let appendMessage proceed normally.
      console.warn(
        `[SessionDO:${ctx.ctx.id}] sendMessage: duplicate-id precheck failed (proceeding):`,
        err,
      )
    }
  }

  // Persist user message (only after orphan preflight so we don't have to
  // roll it back on the auto-fork branch — forkWithHistory appends itself).
  ctx.do.turnCounter++
  const canonicalTurnId = `usr-${ctx.do.turnCounter}`
  const userMsgId = opts?.client_message_id ?? canonicalTurnId
  const userMsg: SessionMessage & { canonical_turn_id?: string } = {
    id: userMsgId,
    role: 'user',
    parts: [...contentToParts(content), buildAwaitingPartImpl('first_token')],
    createdAt: opts?.createdAt ? new Date(opts.createdAt) : new Date(),
    canonical_turn_id: canonicalTurnId,
  }
  try {
    await ctx.do.safeAppendMessage(userMsg)
    ctx.do.persistTurnState()
    // GH#38 P1.5 / B10: emit messages + branchInfo siblings back-to-back on
    // the same DO turn. broadcastBranchInfo no-ops when the new turn didn't
    // introduce a sibling (most sendMessage calls extend the leaf).
    broadcastMessagesImpl(ctx, [userMsg as unknown as WireSessionMessage])
    const siblingRow = computeBranchInfoForUserTurnImpl(ctx, userMsg)
    if (siblingRow) {
      broadcastBranchInfoImpl(ctx, [siblingRow])
    }
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to persist user message:`, err)
  }
  // Spec #80 B1: flip status to 'pending' so UI renders the awaiting bubble
  // while we wait on the first runner event. Runs before the gateway-
  // dispatch branches below so the 'pending' → 'running' transition is
  // monotonic on the happy path.
  ctx.do.updateState({ status: 'pending', error: null })

  if (hasLiveRunner) {
    // Promote state back to running so the UI reflects the new turn.
    if (status !== 'running' && status !== 'waiting_gate') {
      ctx.do.updateState({ status: 'running', error: null })
    }
    sendToGateway(ctx, {
      type: 'stream-input',
      session_id: ctx.state.session_id ?? '',
      message: { role: 'user', content },
      ...(opts?.client_message_id ? { client_message_id: opts.client_message_id } : {}),
    })
  } else if (isResumable) {
    ctx.do.updateState({ status: 'running', error: null })
    void triggerGatewayDialImpl(ctx, {
      type: 'resume',
      project: ctx.state.project,
      prompt: content,
      runner_session_id: ctx.state.runner_session_id ?? '',
    })
  }

  return { ok: true, id: userMsgId }
}
