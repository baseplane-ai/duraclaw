import type { AgentName, SessionMessage as WireSessionMessage } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { contentToParts } from '~/lib/message-parts'
import { promptToPreviewText } from '~/lib/prompt-preview'
import type { SpawnConfig } from '~/lib/types'
import { killSession } from '~/lib/vps-client'
import { buildAwaitingPart as buildAwaitingPartImpl } from './branches'
import { broadcastMessages as broadcastMessagesImpl } from './broadcast'
import { clearPendingGateParts as clearPendingGatePartsImpl } from './gates'
import type { SessionMeta } from './index'
import { maybeReleaseWorktreeOnTerminal } from './maybe-release-worktree'
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

/**
 * GH#107: known agent kinds the runner-side registry recognises.
 * Validated at the DO boundary so we never spawn a VPS process for an
 * unknown agent — `SpawnConfig.agent` is `string | undefined` (it
 * crosses external/persisted boundaries) so we narrow it here.
 */
const KNOWN_AGENTS: ReadonlyArray<AgentName> = ['claude', 'codex']

function validateAgent(agent: string | undefined): AgentName | undefined {
  if (agent === undefined) return undefined
  if (KNOWN_AGENTS.includes(agent as AgentName)) return agent as AgentName
  throw new Error(`unknown_agent:${agent}`)
}

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

  // GH#107: reject unknown agents at the DO boundary BEFORE we mutate
  // any state or spawn a VPS process. Surfaces via the same {ok,error}
  // shape every other validation in this RPC uses.
  let validatedAgent: AgentName | undefined
  try {
    validatedAgent = validateAgent(config.agent)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const now = new Date().toISOString()
  const id = ctx.ctx.id.toString()

  // spawn() requires a prompt — the prompt-less init path is initializeImpl.
  if (config.prompt === undefined) {
    return { ok: false, error: 'spawn requires a prompt; call initialize for prompt-less create' }
  }
  const promptForSpawn: string | import('~/lib/types').ContentBlock[] = config.prompt

  const freshState: SessionMeta = {
    ...DEFAULT_META,
    status: 'running',
    session_id: id,
    userId: ctx.state.userId,
    project: config.project,
    // GH#115: prefer ctx.state.project_path (set by /create body from
    // the resolved worktree path) over the project name fallback. Pre-
    // 115 callers don't set project_path on the body, so the empty
    // string falls back to config.project (today's behavior).
    project_path: ctx.state.project_path || config.project,
    model: config.model ?? null,
    // Store a readable preview, not a JSON blob of base64 image data —
    // see `~/lib/prompt-preview`. Message parts preserve the full
    // ContentBlock[] fidelity; `SessionMeta.prompt` is only for state
    // snapshots / logs.
    prompt: promptToPreviewText(promptForSpawn),
    started_at: now,
    created_at: ctx.state.created_at || now,
    updated_at: now,
    // GH (deferred-runner): persist agent so the fresh-execute fallback in
    // sendMessageImpl can recover it after a hibernation / reaper kill.
    agent: validatedAgent ?? null,
    // GH#115: preserve worktreeId already stamped onto SessionMeta by
    // the /create handler (via http-routes.ts).
    worktreeId: ctx.state.worktreeId ?? null,
  }
  ctx.do.setState(freshState)
  ctx.do.persistMetaPatch(freshState)

  // Persist initial prompt as a user message so it survives reload
  ctx.do.turnCounter++
  const userMsgId = `usr-${ctx.do.turnCounter}`
  const userMsg: SessionMessage & { canonical_turn_id?: string } = {
    id: userMsgId,
    role: 'user',
    parts: [...contentToParts(promptForSpawn), buildAwaitingPartImpl('first_token')],
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
    prompt: promptForSpawn,
    model: config.model,
    // SpawnConfig.agent stays `string` for now (it reads persisted /
    // external data — see GH#107 P1 spec). Validated above; the
    // runner-side registry double-checks at boot.
    agent: validatedAgent,
    system_prompt: config.system_prompt,
    allowed_tools: config.allowed_tools,
    max_turns: config.max_turns,
    max_budget_usd: config.max_budget_usd,
  })

  console.log(
    `[SessionDO:${id}] spawn: ${config.project} "${typeof promptForSpawn === 'string' ? promptForSpawn.slice(0, 80) : '[content blocks]'}"`,
  )
  return { ok: true, session_id: id }
}

/**
 * Prompt-less session init for the deferred-runner flow. Sets up SessionMeta
 * (project, model, agent, userId) without persisting a user message and
 * without dialling the gateway. The session sits at status='idle' until the
 * first sendMessage triggers the fresh-execute fallback in sendMessageImpl.
 *
 * Idempotent against double-create: if the DO already has a project set, we
 * treat the call as a no-op success rather than overwriting state.
 */
export async function initializeImpl(
  ctx: SessionDOContext,
  config: SpawnConfig,
): Promise<{ ok: boolean; session_id?: string; error?: string }> {
  const id = ctx.ctx.id.toString()

  // Idempotency — if the DO already has any meaningful state, don't clobber.
  // A retry of /create from the same client_session_id should be safe.
  if (
    ctx.state.status === 'running' ||
    ctx.state.status === 'waiting_gate' ||
    ctx.state.status === 'pending'
  ) {
    return { ok: false, error: 'Session already active' }
  }
  if (ctx.state.project && ctx.state.project === config.project) {
    return { ok: true, session_id: id }
  }

  let validatedAgent: AgentName | undefined
  try {
    validatedAgent = validateAgent(config.agent)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const now = new Date().toISOString()
  const initState: SessionMeta = {
    ...DEFAULT_META,
    status: 'idle',
    session_id: id,
    userId: ctx.state.userId,
    project: config.project,
    // GH#115: prefer ctx.state.project_path (set by /create body) over
    // the project name fallback. See spawnImpl note.
    project_path: ctx.state.project_path || config.project,
    model: config.model ?? null,
    prompt: '',
    started_at: null,
    created_at: ctx.state.created_at || now,
    updated_at: now,
    agent: validatedAgent ?? null,
    // GH#115: preserve worktreeId already stamped by /create handler.
    worktreeId: ctx.state.worktreeId ?? null,
  }
  ctx.do.setState(initState)
  ctx.do.persistMetaPatch(initState)

  console.log(
    `[SessionDO:${id}] initialize: ${config.project} agent=${validatedAgent ?? '(default)'} model=${config.model ?? '(default)'} (no runner; deferred to first sendMessage)`,
  )
  return { ok: true, session_id: id }
}

export async function resumeDiscoveredImpl(
  ctx: SessionDOContext,
  config: SpawnConfig,
  runnerSessionId: string,
): Promise<{ ok: boolean; session_id?: string; error?: string }> {
  // Mirror spawn()'s guard — 'pending' is an active state (spec #80).
  if (
    ctx.state.status === 'running' ||
    ctx.state.status === 'waiting_gate' ||
    ctx.state.status === 'pending'
  ) {
    return { ok: false, error: 'Session already active' }
  }

  // GH#107: reject unknown agents at the DO boundary, same as spawnImpl.
  let validatedAgent: AgentName | undefined
  try {
    validatedAgent = validateAgent(config.agent)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  const now = new Date().toISOString()
  const id = ctx.ctx.id.toString()

  // resumeDiscovered is invoked from /create when a runner_session_id is
  // already known (the gateway saw an alive runner the DO didn't know
  // about). The original /create payload always carries a prompt for this
  // path; default defensively if it's somehow absent.
  const resumePrompt: string | import('~/lib/types').ContentBlock[] = config.prompt ?? ''

  const resumeState: SessionMeta = {
    ...DEFAULT_META,
    status: 'running',
    session_id: id,
    userId: ctx.state.userId,
    project: config.project,
    // GH#115: prefer ctx.state.project_path (set by /create body) over
    // the project name fallback. See spawnImpl note.
    project_path: ctx.state.project_path || config.project,
    model: config.model ?? null,
    // Readable preview — not a JSON blob. See `~/lib/prompt-preview`.
    prompt: promptToPreviewText(resumePrompt),
    started_at: now,
    created_at: ctx.state.created_at || now,
    updated_at: now,
    runner_session_id: runnerSessionId,
    agent: validatedAgent ?? null,
    // GH#115: preserve worktreeId already stamped by /create handler.
    worktreeId: ctx.state.worktreeId ?? null,
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
    parts: contentToParts(resumePrompt),
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
    prompt: resumePrompt,
    runner_session_id: runnerSessionId,
    // See note in spawnImpl above — SpawnConfig.agent is wider than
    // AgentName by design; validated at the wire boundary.
    agent: validatedAgent,
  })

  console.log(
    `[SessionDO:${id}] resumeDiscovered: ${config.project} runner_session=${runnerSessionId.slice(0, 12)}`,
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
  if (!ctx.state.runner_session_id) {
    return { ok: false, error: 'No runner_session_id — nothing to reattach' }
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
    runner_session_id: ctx.state.runner_session_id,
  })
  return { ok: true }
}

export async function resumeFromTranscriptImpl(
  ctx: SessionDOContext,
): Promise<{ ok: boolean; error?: string }> {
  if (!ctx.state.runner_session_id) {
    return { ok: false, error: 'No runner_session_id — nothing to resume' }
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
    runner_session_id: ctx.state.runner_session_id,
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

  // GH#115 §B-LIFECYCLE-2: terminal-transition release-on-close.
  maybeReleaseWorktreeOnTerminal(ctx)

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
  sendToGateway(ctx, { type: 'stop', session_id: ctx.state.session_id ?? '' })
  // GH#115 §B-LIFECYCLE-2: terminal-transition release-on-close.
  maybeReleaseWorktreeOnTerminal(ctx)
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

  // GH#115 §B-LIFECYCLE-2: terminal-transition release-on-close.
  maybeReleaseWorktreeOnTerminal(ctx)

  // Best-effort in-band abort — harmless if the WS is dead.
  if (sessionId) {
    sendToGateway(ctx, { type: 'stop', session_id: sessionId })
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
