import type { SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { contentToParts } from '~/lib/message-parts'
import { promptToPreviewText } from '~/lib/prompt-preview'
import type { SpawnConfig } from '~/lib/types'
import { killSession } from '~/lib/vps-client'
import { buildAwaitingPart as buildAwaitingPartImpl } from './branches'
import { broadcastMessages as broadcastMessagesImpl } from './broadcast'
import { clearPendingGateParts as clearPendingGatePartsImpl } from './gates'
import type { SessionMeta } from './index'
import { sendToGateway, triggerGatewayDial as triggerGatewayDialImpl } from './runner-link'
import { DEFAULT_META, type SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted bodies for the lifecycle @callable RPCs —
 * spawn / resumeDiscovered / reattach / resumeFromTranscript / stop /
 * abort / forceStop / interrupt. Pure delegation, no behavior change.
 *
 * The DO-class shims are single-line `return *Impl(this.moduleCtx, ...)`
 * calls. Idempotency, status-flip, gateway dispatch, and history
 * persistence all live here.
 */

export async function spawnImpl(
  ctx: SessionDOContext,
  config: SpawnConfig,
): Promise<{ ok: boolean; session_id?: string; error?: string }> {
  // 'pending' is the post-spawn intermediate state (spec #80) flipped
  // below before the runner's first event lands. Without it in the
  // guard, a concurrent second spawn() — always fired by
  // AgentDetailWithSpawn once the WS opens on draft→real tab swap —
  // races past this idempotency check, appends a second `usr-N`
  // message, and broadcasts it. Symptom: two identical user bubbles
  // on new-session-draft first submit.
  if (
    ctx.state.status === 'running' ||
    ctx.state.status === 'waiting_gate' ||
    ctx.state.status === 'pending'
  ) {
    return { ok: false, error: 'Session already active' }
  }

  const now = new Date().toISOString()
  const id = ctx.ctx.id.toString()

  const freshState: SessionMeta = {
    ...DEFAULT_META,
    status: 'running',
    session_id: id,
    userId: ctx.state.userId,
    project: config.project,
    project_path: config.project,
    model: config.model ?? null,
    // Store a readable preview, not a JSON blob of base64 image data —
    // see `~/lib/prompt-preview`. Message parts preserve the full
    // ContentBlock[] fidelity; `SessionMeta.prompt` is only for state
    // snapshots / logs.
    prompt: promptToPreviewText(config.prompt),
    started_at: now,
    created_at: ctx.state.created_at || now,
    updated_at: now,
  }
  ctx.do.setState(freshState)
  ctx.do.persistMetaPatch(freshState)

  // Persist initial prompt as a user message so it survives reload
  ctx.do.turnCounter++
  const userMsgId = `usr-${ctx.do.turnCounter}`
  const userMsg: SessionMessage & { canonical_turn_id?: string } = {
    id: userMsgId,
    role: 'user',
    parts: [...contentToParts(config.prompt), buildAwaitingPartImpl('first_token')],
    createdAt: new Date(),
    canonical_turn_id: userMsgId,
  }
  try {
    await ctx.do.safeAppendMessage(userMsg)
    ctx.do.persistTurnState()
    broadcastMessagesImpl(ctx, [userMsg as unknown as WireSessionMessage])
  } catch (err) {
    console.error(`[SessionDO:${id}] Failed to persist initial prompt:`, err)
  }
  // Spec #80 B2: flip status to 'pending' so UI renders the awaiting
  // bubble while we wait on the first runner event.
  ctx.do.updateState({ status: 'pending', error: null })

  void triggerGatewayDialImpl(ctx, {
    type: 'execute',
    project: config.project,
    prompt: config.prompt,
    model: config.model,
    agent: config.agent,
    system_prompt: config.system_prompt,
    allowed_tools: config.allowed_tools,
    max_turns: config.max_turns,
    max_budget_usd: config.max_budget_usd,
  })

  console.log(
    `[SessionDO:${id}] spawn: ${config.project} "${typeof config.prompt === 'string' ? config.prompt.slice(0, 80) : '[content blocks]'}"`,
  )
  return { ok: true, session_id: id }
}

export async function resumeDiscoveredImpl(
  ctx: SessionDOContext,
  config: SpawnConfig,
  sdkSessionId: string,
): Promise<{ ok: boolean; session_id?: string; error?: string }> {
  // Mirror spawn()'s guard — 'pending' is an active state (spec #80).
  if (
    ctx.state.status === 'running' ||
    ctx.state.status === 'waiting_gate' ||
    ctx.state.status === 'pending'
  ) {
    return { ok: false, error: 'Session already active' }
  }

  const now = new Date().toISOString()
  const id = ctx.ctx.id.toString()

  const resumeState: SessionMeta = {
    ...DEFAULT_META,
    status: 'running',
    session_id: id,
    userId: ctx.state.userId,
    project: config.project,
    project_path: config.project,
    model: config.model ?? null,
    // Readable preview — not a JSON blob. See `~/lib/prompt-preview`.
    prompt: promptToPreviewText(config.prompt),
    started_at: now,
    created_at: ctx.state.created_at || now,
    updated_at: now,
    sdk_session_id: sdkSessionId,
  }
  ctx.do.setState(resumeState)
  ctx.do.persistMetaPatch(resumeState)

  // Persist resume prompt as a user message — use contentToParts so
  // image-paste resumes preserve the image/text block fidelity instead
  // of collapsing to a single text part with stringified JSON.
  ctx.do.turnCounter++
  const userMsgId = `usr-${ctx.do.turnCounter}`
  const userMsg: SessionMessage & { canonical_turn_id?: string } = {
    id: userMsgId,
    role: 'user',
    parts: contentToParts(config.prompt),
    createdAt: new Date(),
    canonical_turn_id: userMsgId,
  }
  try {
    await ctx.do.safeAppendMessage(userMsg)
    ctx.do.persistTurnState()
    broadcastMessagesImpl(ctx, [userMsg as unknown as WireSessionMessage])
  } catch (err) {
    console.error(`[SessionDO:${id}] Failed to persist resume prompt:`, err)
  }

  void triggerGatewayDialImpl(ctx, {
    type: 'resume',
    project: config.project,
    prompt: config.prompt,
    sdk_session_id: sdkSessionId,
    agent: config.agent,
  })

  console.log(
    `[SessionDO:${id}] resumeDiscovered: ${config.project} sdk_session=${sdkSessionId.slice(0, 12)}`,
  )
  return { ok: true, session_id: id }
}

export async function reattachImpl(
  ctx: SessionDOContext,
): Promise<{ ok: boolean; error?: string }> {
  const hasLiveRunner = Boolean(ctx.do.getGatewayConnectionId())
  if (hasLiveRunner) {
    return { ok: true } // already connected
  }
  if (!ctx.state.sdk_session_id) {
    return { ok: false, error: 'No sdk_session_id — nothing to reattach' }
  }
  if (!ctx.state.project) {
    return { ok: false, error: 'No project set — cannot dial gateway' }
  }
  if (!ctx.env.CC_GATEWAY_URL || !ctx.env.WORKER_PUBLIC_URL) {
    return {
      ok: false,
      error: 'Gateway not configured (missing CC_GATEWAY_URL or WORKER_PUBLIC_URL)',
    }
  }

  ctx.do.updateState({ status: 'running', error: null })
  void triggerGatewayDialImpl(ctx, {
    type: 'resume',
    project: ctx.state.project,
    prompt: '',
    sdk_session_id: ctx.state.sdk_session_id,
  })
  return { ok: true }
}

export async function resumeFromTranscriptImpl(
  ctx: SessionDOContext,
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.state.sdk_session_id) {
    return { ok: false, error: 'No sdk_session_id — nothing to resume' }
  }
  if (!ctx.state.project) {
    return { ok: false, error: 'No project set — cannot dial gateway' }
  }
  if (!ctx.env.CC_GATEWAY_URL || !ctx.env.WORKER_PUBLIC_URL) {
    return {
      ok: false,
      error: 'Gateway not configured (missing CC_GATEWAY_URL or WORKER_PUBLIC_URL)',
    }
  }

  // triggerGatewayDial handles token rotation internally — it closes
  // the old gateway WS with 4410 before POSTing to spawn a new runner.
  // That 4410 is what kills the orphan.
  ctx.do.updateState({ status: 'running', error: null })
  void triggerGatewayDialImpl(ctx, {
    type: 'resume',
    project: ctx.state.project,
    prompt: '',
    sdk_session_id: ctx.state.sdk_session_id,
  })
  return { ok: true }
}

export async function stopImpl(
  ctx: SessionDOContext,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (ctx.state.status !== 'running' && ctx.state.status !== 'waiting_gate') {
    return { ok: false, error: `Cannot stop: status is '${ctx.state.status}'` }
  }

  // Transition unilaterally so stop unsticks sessions even when the gateway WS
  // is half-open / dead. The gateway send is best-effort — its ack can't be
  // trusted to arrive, so we don't gate local recovery on it.
  ctx.do.updateState({
    status: 'idle',
    error: null,
    active_callback_token: undefined,
  })

  const gwConnId = ctx.do.getGatewayConnectionId()
  if (gwConnId) {
    sendToGateway(ctx, { type: 'stop', session_id: ctx.state.session_id ?? '' })
  }

  console.log(`[SessionDO:${ctx.ctx.id}] stop: ${reason ?? 'user request'}`)
  return { ok: true }
}

export async function abortImpl(
  ctx: SessionDOContext,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  clearPendingGatePartsImpl(ctx)
  ctx.do.updateState({
    status: 'idle',
    error: null,
    active_callback_token: undefined,
  })
  sendToGateway(ctx, { type: 'abort', session_id: ctx.state.session_id ?? '' })
  console.log(`[SessionDO:${ctx.ctx.id}] abort: ${reason ?? 'user request'}`)
  return { ok: true }
}

export interface ForceStopResult {
  ok: boolean
  error?: string
  kill:
    | { kind: 'skipped'; reason: 'no_gateway_url' | 'no_session_id' }
    | { kind: 'signalled'; pid: number; sigkill_grace_ms: number }
    | { kind: 'already_terminal'; state: string }
    | { kind: 'not_found' }
    | { kind: 'unreachable'; reason: string }
}

export async function forceStopImpl(
  ctx: SessionDOContext,
  reason?: string,
): Promise<ForceStopResult> {
  // Always clear pending gate parts — even from idle / error, the UI
  // may still be rendering a GateResolver against a stale message.
  clearPendingGatePartsImpl(ctx)

  const sessionId = ctx.state.session_id

  // Fast path: nothing to stop. Already idle and no session_id means
  // there's no runner to SIGTERM and no state to flip — return early
  // so we don't make a pointless gateway round-trip.
  if (ctx.state.status === 'idle' && !sessionId) {
    return { ok: true, kill: { kind: 'skipped', reason: 'no_session_id' } }
  }

  ctx.do.updateState({
    status: 'idle',
    error: null,
    active_callback_token: undefined,
  })

  // Best-effort in-band abort — harmless if the WS is dead.
  if (sessionId) {
    sendToGateway(ctx, { type: 'abort', session_id: sessionId })
  }

  // Out-of-band SIGTERM via gateway HTTP. This is the slice that
  // actually rescues the stuck-runner case.
  const gatewayUrl = ctx.env.CC_GATEWAY_URL
  let killResult: ForceStopResult['kill']
  if (!gatewayUrl) {
    killResult = { kind: 'skipped', reason: 'no_gateway_url' }
  } else if (!sessionId) {
    killResult = { kind: 'skipped', reason: 'no_session_id' }
  } else {
    killResult = await killSession(gatewayUrl, ctx.env.CC_GATEWAY_SECRET, sessionId, 5_000)
  }

  console.log(
    `[SessionDO:${ctx.ctx.id}] forceStop: ${reason ?? 'user request'} kill=${killResult.kind}`,
  )
  return { ok: true, kill: killResult }
}

export async function interruptImpl(
  ctx: SessionDOContext,
): Promise<{ ok: boolean; error?: string }> {
  // Always clear pending gate parts first — the GateResolver UI is
  // mounted off `isPendingGate`, and the user may be hitting Stop
  // from any status (idle / error / waiting_input / etc.) to dismiss
  // a stuck modal. This is decoupled from the runner-side interrupt:
  // the loop is idempotent and safe to run with no live SDK.
  clearPendingGatePartsImpl(ctx)

  // No live runner to interrupt — UI was unblocked, we're done.
  if (ctx.state.status !== 'running' && ctx.state.status !== 'waiting_gate') {
    return { ok: true }
  }

  // Flip status back to running so the watchdog and UI agree.
  if (ctx.state.status === 'waiting_gate') {
    ctx.do.updateState({ status: 'running' })
  }

  sendToGateway(ctx, { type: 'interrupt', session_id: ctx.state.session_id ?? '' })
  return { ok: true }
}
