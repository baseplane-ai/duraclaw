import type {
  AdapterCapabilities,
  SyncedCollectionOp,
  SessionMessage as WireSessionMessage,
} from '@duraclaw/shared-types'
import { Agent, type Connection, type ConnectionContext, callable } from 'agents'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { Session } from 'agents/experimental/memory/session'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { runMigrations } from '~/lib/do-migrations'
import type { PushPayload } from '~/lib/push'
import type {
  ContentBlock,
  ContextUsage,
  Env,
  GateResponse,
  GatewayEvent,
  KataSessionState,
  SessionStatus,
  SpawnConfig,
} from '~/lib/types'
import { SESSION_DO_MIGRATIONS } from '../session-do-migrations'
import {
  checkAwaitingTimeoutImpl,
  clearAwaitingResponseImpl,
  failAwaitingTurnImpl,
  fireRunawayInterruptImpl,
  recoverFromDroppedConnectionImpl,
} from './awaiting'
import { forkWithHistoryImpl, resubmitMessageImpl } from './branches'
import {
  broadcastGatewayEvent as broadcastGatewayEventImpl,
  broadcastMessages as broadcastMessagesImpl,
  broadcastToClients as broadcastToClientsImpl,
} from './broadcast'
import {
  handleOnClose,
  handleOnConnect,
  handleOnError,
  handleOnMessage,
  logError as logErrorImpl,
} from './client-ws'
import { dispatchPushImpl } from './dispatch-push'
import { gcEventLog, getEventLogImpl, logEvent } from './event-log'
import { getFeatureFlagEnabledImpl } from './feature-flags'
import { handleGatewayEvent as handleGatewayEventImpl } from './gateway-event-handler'
import {
  persistTurnState as persistTurnStateImpl,
  safeAppendMessage as safeAppendMessageImpl,
  safeUpdateMessage as safeUpdateMessageImpl,
} from './history'
import { handleHttpRequest } from './http-routes'
import { runHydration } from './hydration'
import { handleModeTransitionImpl, maybeAutoAdvanceChainImpl } from './mode-transition'
import { resolveGateImpl } from './rpc-gates'
import {
  abortImpl,
  type ForceStopResult,
  forceStopImpl,
  initializeImpl,
  interruptImpl,
  reattachImpl,
  resumeDiscoveredImpl,
  resumeFromTranscriptImpl,
  spawnImpl,
  stopImpl,
} from './rpc-lifecycle'
import { type SendMessageOpts, type SendMessageResult, sendMessageImpl } from './rpc-messages'
import {
  getBranchHistoryImpl,
  getContextUsageImpl,
  getKataStateImpl,
  getKataStatusImpl,
  getMessagesImpl,
  getStatusImpl,
  requestSnapshotImpl,
} from './rpc-queries'
import {
  getGatewayConnectionId as getGatewayConnectionIdImpl,
  maybeRecoverAfterGatewayDrop as maybeRecoverAfterGatewayDropImpl,
} from './runner-link'
import {
  persistMetaPatch as persistMetaPatchImpl,
  syncContextUsageToD1 as syncContextUsageToD1Impl,
  updateState as updateStateImpl,
} from './status'
import { gcTranscript } from './transcript'
import { DEFAULT_META, type SessionDOContext } from './types'
import { runAlarm } from './watchdog'

/**
 * Internal DO meta shape (#31 B10). Durable fields persist to `session_meta`
 * (v7); transient (`updated_at`, `active_callback_token`) stay in setState.
 * External code reads status/gate from messages and summary/cost/turns from D1.
 */
export interface SessionMeta {
  status: SessionStatus
  session_id: string | null
  project: string
  project_path: string
  model: string | null
  prompt: string
  userId: string | null
  started_at: string | null
  completed_at: string | null
  num_turns: number
  total_cost_usd: number | null
  duration_ms: number | null
  created_at: string
  updated_at: string
  result: string | null
  error: string | null
  summary: string | null
  runner_session_id: string | null
  /**
   * Adapter capability flags reported by the runner on `session.init`.
   * `null` until the runner first reports (or for legacy runners that
   * never report). Persisted as JSON in `session_meta.capabilities_json`.
   */
  capabilities: AdapterCapabilities | null
  active_callback_token?: string
  /** GH#115: FK into D1 worktrees(id). Used to source `worktree_path`
   *  for ExecuteCommand / ResumeCommand. NULL until first reserve. */
  worktreeId?: string | null
  lastKataMode?: string
  /** GH#73: true once runner observed `run-end.json`. Gate for chain auto-advance. */
  lastRunEnded?: boolean
  /** GH#86: Haiku-generated title + provenance. `title_source: 'user'` freezes the title. */
  title?: string | null
  title_confidence?: number | null
  title_set_at_turn?: number | null
  title_source?: 'user' | 'haiku' | null
  /**
   * Runner adapter choice (e.g. 'claude', 'codex'). Persisted so the
   * deferred-runner flow can recover it on the first sendMessage when the
   * runner is being dialled fresh (no runner_session_id, no live runner).
   * Null on rehydrate of pre-v19 sessions — fresh-execute defaults to 'claude'.
   */
  agent?: string | null
  /**
   * GH#119 P3: alarm-loop retry counter for the `waiting_identity` state.
   * Bumps on each alarm tick that finds zero available identities; resets
   * to 0 on a successful failover or terminal session state. Capped at 30
   * (≈30min @ 60s ticks) before the session is declared failed with
   * `error: 'All identities exhausted'`. Persisted in
   * `session_meta.waiting_identity_retries` (migration v21) so the counter
   * survives DO hibernation between alarm ticks.
   */
  waiting_identity_retries: number
}

/**
 * SessionDO — one Durable Object per CC session. Bidirectional relay:
 *   Browser WS <-> SessionDO <-> Gateway WS
 * Facade — RPCs / lifecycle / WS routing delegate to extracted modules under
 * `./session-do/`. Constants (DEFAULT_META, META_COLUMN_MAP, ALARM_INTERVAL_MS,
 * RECOVERY_GRACE_MS, RUNAWAY_EMPTY_TURN_THRESHOLD, REPEATED_TURN_THRESHOLD,
 * parseTurnOrdinal) live in `./types.ts`.
 */
export class SessionDO extends Agent<Env, SessionMeta> {
  initialState = DEFAULT_META
  private session!: Session
  /** SessionDOContext (spec #101 B3) — live-reference bag for extracted modules. Built once in onStart, never reconstructed. */
  moduleCtx!: SessionDOContext
  /** Mutable DO-instance state read+written by extracted modules via ctx.do. */
  turnCounter = 0
  /**
   * Independent ordinal for assistant-side rows (`msg-N` / `err-N`). The
   * user-side `turnCounter` advances only when the user actually sends a
   * turn — bumping it from inside an assistant-side mid-stream event
   * (partial_assistant, tool_result, error, runaway interrupt) corrupts
   * the sort key on the *next* user row by incrementing it ahead of time.
   * The client's sortKey (use-messages-collection.ts) already accepts the
   * union /^(?:usr|msg|err)-(\d+)$/, so the two counters are free to
   * advance independently and produce a stable per-turn block ordering.
   */
  assistantTurnCounter = 0
  currentTurnMessageId: string | null = null
  /** Runaway-turn guards (#101 Stage 5): empty-turn counter + recent-content fingerprint ring. Memory-only. */
  consecutiveEmptyAssistantTurns = 0
  recentTurnFingerprints: string[] = []
  /** Cached gateway connection ID — avoids SQLite reads on every message. */
  cachedGatewayConnId: string | null = null
  /** Timestamp of the last gateway event received on the WS connection. */
  lastGatewayActivity = 0
  /** GH#57: pending recovery timer — set when WS drops but gateway says runner is alive. Cleared on re-dial. */
  recoveryGraceTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-session monotonic seq for MessagesFrame broadcasts (#14 B1). Persisted in `session_meta.message_seq`. */
  messageSeq = 0
  /** 5s trailing-edge debounce slot for context_usage D1 writes. */
  contextUsageDebounce: { timer: ReturnType<typeof setTimeout> | null; pending: string | null } = {
    timer: null,
    pending: null,
  }
  /** P3 B4: single-flight `getContextUsage` probe + pending resolvers drained on `context_usage` event. */
  contextUsageProbeInFlight: Promise<ContextUsage | null> | null = null
  contextUsageResolvers: Array<{
    resolve: (v: ContextUsage | null) => void
    reject: (e: unknown) => void
  }> = []
  /** GH#86: D1 feature-flag cache (TTL'd). Read by triggerGatewayDial; fail-open on D1 errors. */
  featureFlagCache = new Map<string, { enabled: boolean; expiresAt: number }>()

  // ── Lifecycle ──────────────────────────────────────────────────

  async onStart() {
    runMigrations(this.ctx.storage.sql, SESSION_DO_MIGRATIONS)
    this.session = Session.create(this)
    // Build SessionDOContext (spec #101 B3) — live references, never reconstructed.
    // `state` MUST be a live getter that delegates to `this.state` (the Agent
    // base class's reactive state proxy). Capturing `this.state` as a plain
    // property here would freeze a snapshot — `setState` reassigns the
    // underlying `_state` on every call, so a captured reference goes stale
    // immediately on the first `updateState()`.
    const moduleCtx = {
      do: this,
      session: this.session,
      sql: this.ctx.storage.sql,
      env: this.env,
      ctx: this.ctx,
      broadcast: (data: string) => this.broadcastToClients(data),
      getConnections: () => Array.from(this.getConnections()),
      logEvent: (
        level: 'info' | 'warn' | 'error',
        tag: string,
        message: string,
        attrs?: Record<string, unknown>,
      ) => logEvent(this.moduleCtx, level, tag, message, attrs),
    } as Omit<SessionDOContext, 'state'> as SessionDOContext
    Object.defineProperty(moduleCtx, 'state', {
      get: () => this.state,
      enumerable: true,
      configurable: false,
    })
    this.moduleCtx = moduleCtx
    await runHydration(this.moduleCtx)
    gcEventLog(this.moduleCtx)
    gcTranscript(this.moduleCtx)
  }

  async onRequest(request: Request): Promise<Response> {
    const matched = await handleHttpRequest(this.moduleCtx, request)
    if (matched !== null) return matched
    return super.onRequest(request)
  }

  /** Suppress Agent-SDK protocol messages (#31 B9). */
  shouldSendProtocolMessages(_connection: Connection, _ctx: ConnectionContext): boolean {
    return false
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    return handleOnConnect(this.moduleCtx, connection, ctx)
  }

  onMessage(connection: Connection, data: string | ArrayBuffer) {
    try {
      const verdict = handleOnMessage(this.moduleCtx, connection, data)
      if (verdict !== 'rpc') return
      super.onMessage(connection, data)
    } catch (err) {
      logErrorImpl(this.moduleCtx, 'onMessage', err, { connId: connection.id })
      throw err
    }
  }

  onClose(connection: Connection, code: number, reason: string, _wasClean: boolean) {
    try {
      handleOnClose(this.moduleCtx, connection, code, reason)
      super.onClose(connection, code, reason, _wasClean)
    } catch (err) {
      logErrorImpl(this.moduleCtx, 'onClose', err, { connId: connection.id, code, reason })
      throw err
    }
  }

  onError(connection: Connection | unknown, error?: unknown): void {
    handleOnError(this.moduleCtx, connection, error)
  }

  /** DO alarm — Cloudflare lifecycle method, must stay on class. Body in ./watchdog.ts. */
  async alarm() {
    await runAlarm(this.moduleCtx)
  }

  // ── Module-bound shims (called via ctx.do or external callers) ────

  async safeAppendMessage(msg: SessionMessage, parentId?: string | null): Promise<void> {
    return safeAppendMessageImpl(this.moduleCtx, msg, parentId)
  }
  safeUpdateMessage(msg: SessionMessage): void {
    safeUpdateMessageImpl(this.moduleCtx, msg)
  }
  clearAwaitingResponse(): void {
    clearAwaitingResponseImpl(this.moduleCtx)
  }
  /** #80 B7: alarm-driven awaiting-turn timeout. */
  async checkAwaitingTimeout(): Promise<void> {
    return checkAwaitingTimeoutImpl(this.moduleCtx)
  }
  /** #80 B7: terminal failure path for in-flight awaiting turn. */
  async failAwaitingTurn(errorText: string): Promise<void> {
    return failAwaitingTurnImpl(this.moduleCtx, errorText)
  }
  /** B7 status-aware recovery — gateway-WS close path probe. */
  async maybeRecoverAfterGatewayDrop() {
    return maybeRecoverAfterGatewayDropImpl(this.moduleCtx)
  }
  /** GH#86: D1 feature-flag read with 5min cache; fail-open. */
  async getFeatureFlagEnabled(flagId: string, defaultValue: boolean): Promise<boolean> {
    return getFeatureFlagEnabledImpl(this.moduleCtx, flagId, defaultValue)
  }
  async recoverFromDroppedConnection() {
    return recoverFromDroppedConnectionImpl(this.moduleCtx)
  }
  updateState(partial: Partial<SessionMeta>) {
    return updateStateImpl(this.moduleCtx, partial)
  }
  persistMetaPatch(partial: Partial<SessionMeta>) {
    return persistMetaPatchImpl(this.moduleCtx, partial)
  }
  broadcastToClients(data: string) {
    return broadcastToClientsImpl(this.moduleCtx, data)
  }
  broadcastGatewayEvent(event: GatewayEvent) {
    return broadcastGatewayEventImpl(this.moduleCtx, event)
  }
  /** Chain auto-advance (16-chain-ux-p1-5 B6/B7/B9). */
  async maybeAutoAdvanceChain(): Promise<void> {
    return maybeAutoAdvanceChainImpl(this.moduleCtx)
  }
  broadcastMessages(
    rowsOrOps: WireSessionMessage[] | { ops: SyncedCollectionOp<WireSessionMessage>[] },
    opts: { targetClientId?: string } = {},
  ): void {
    broadcastMessagesImpl(this.moduleCtx, rowsOrOps, opts)
  }
  persistTurnState() {
    return persistTurnStateImpl(this.moduleCtx)
  }
  /** Drizzle handle scoped to this DO's request env (lazy, fresh per call). */
  get d1() {
    return drizzle(this.env.AUTH_DB, { schema })
  }
  syncContextUsageToD1(json: string) {
    return syncContextUsageToD1Impl(this.moduleCtx, this.contextUsageDebounce, json)
  }
  /** Chain UX P4 — mode-enter session reset on `kata_state` mode change. */
  async handleModeTransition(kataState: KataSessionState, fromMode: string | null) {
    return handleModeTransitionImpl(this.moduleCtx, kataState, fromMode)
  }
  getGatewayConnectionId(): string | null {
    return getGatewayConnectionIdImpl(this.moduleCtx)
  }
  async dispatchPush(payload: PushPayload, eventType: 'blocked' | 'completed' | 'error') {
    return dispatchPushImpl(this.moduleCtx, payload, eventType)
  }
  /** Runaway-loop guard fire path (empty-turn + repeated-content). */
  fireRunawayInterrupt(
    errorCode: string,
    userVisibleMessage: string,
    diagnostics: { kind: 'empty' | 'repeated'; consecutive: number },
  ): void {
    fireRunawayInterruptImpl(this.moduleCtx, errorCode, userVisibleMessage, diagnostics)
  }
  /** Resume a discovered VPS session by runner_session_id (called from /create). */
  async resumeDiscovered(
    config: SpawnConfig,
    runnerSessionId: string,
  ): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    return resumeDiscoveredImpl(this.moduleCtx, config, runnerSessionId)
  }
  /**
   * Prompt-less initialize for the deferred-runner flow (called from /create
   * when the body has no prompt). Sets up SessionMeta but does not dial the
   * gateway — runner spawns lazily on the first sendMessage.
   */
  async initialize(
    config: SpawnConfig,
  ): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    return initializeImpl(this.moduleCtx, config)
  }

  handleGatewayEvent(event: GatewayEvent) {
    return handleGatewayEventImpl(this.moduleCtx, event)
  }

  // ── @callable RPC stubs (decorators stay on class — see #101 hint #4) ────

  @callable()
  async reattach(): Promise<{ ok: boolean; error?: string }> {
    return reattachImpl(this.moduleCtx)
  }
  @callable()
  async resumeFromTranscript(): Promise<{ ok: boolean; error?: string }> {
    return resumeFromTranscriptImpl(this.moduleCtx)
  }
  @callable()
  async spawn(config: SpawnConfig): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    return spawnImpl(this.moduleCtx, config)
  }
  @callable()
  async stop(reason?: string): Promise<{ ok: boolean; error?: string }> {
    return stopImpl(this.moduleCtx, reason)
  }
  @callable()
  async abort(reason?: string): Promise<{ ok: boolean; error?: string }> {
    return abortImpl(this.moduleCtx, reason)
  }
  @callable()
  async forceStop(reason?: string): Promise<ForceStopResult> {
    return forceStopImpl(this.moduleCtx, reason)
  }
  @callable()
  async resolveGate(
    gateId: string,
    response: GateResponse,
  ): Promise<{ ok: boolean; error?: string }> {
    return resolveGateImpl(this.moduleCtx, gateId, response)
  }
  @callable()
  async getEventLog(opts?: { tag?: string; sinceTs?: number; limit?: number }): Promise<
    Array<{
      seq: number
      ts: number
      level: string
      tag: string
      message: string
      attrs: string | null
    }>
  > {
    return getEventLogImpl(this.moduleCtx, opts)
  }
  @callable()
  async recordReapDecision(args: {
    decision: 'skip-pending-gate' | 'kill-stale' | 'kill-dead-runner'
    attrs?: Record<string, unknown>
  }): Promise<{ ok: true }> {
    logEvent(this.moduleCtx, 'info', 'reap', `decision=${args.decision}`, args.attrs ?? {})
    return { ok: true }
  }
  @callable()
  async sendMessage(
    content: string | ContentBlock[],
    opts?: SendMessageOpts,
  ): Promise<SendMessageResult> {
    return sendMessageImpl(this.moduleCtx, content, opts)
  }
  @callable()
  async forkWithHistory(
    content: string | ContentBlock[],
    opts?: { worktreeId?: string | null },
  ): Promise<{ ok: boolean; error?: string }> {
    return forkWithHistoryImpl(this.moduleCtx, content, opts)
  }
  @callable()
  async interrupt(): Promise<{ ok: boolean; error?: string }> {
    return interruptImpl(this.moduleCtx)
  }
  @callable()
  async getContextUsage(): Promise<{
    contextUsage: ContextUsage | null
    fetchedAt: string
    isCached: boolean
  }> {
    return getContextUsageImpl(this.moduleCtx)
  }
  async getKataState(): Promise<{ kataState: KataSessionState | null; fetchedAt: string }> {
    return getKataStateImpl(this.moduleCtx)
  }
  @callable()
  async getMessages(opts?: {
    offset?: number
    limit?: number
    session_hint?: string
    leafId?: string
  }): Promise<{ ok: true }> {
    return getMessagesImpl(this.moduleCtx, opts)
  }
  @callable()
  async resubmitMessage(
    originalMessageId: string,
    newContent: string,
  ): Promise<{ ok: boolean; leafId?: string; error?: string }> {
    return resubmitMessageImpl(this.moduleCtx, originalMessageId, newContent)
  }
  @callable()
  async getBranchHistory(
    leafId: string,
  ): Promise<{ ok: true } | { ok: false; error: 'unknown_leaf' | 'not_on_branch' }> {
    return getBranchHistoryImpl(this.moduleCtx, leafId)
  }
  @callable()
  async requestSnapshot(
    opts: { targetClientId?: string } = {},
  ): Promise<{ ok: true } | { ok: false; error: 'session_empty' }> {
    return requestSnapshotImpl(this.moduleCtx, opts)
  }
  @callable()
  async getStatus() {
    return getStatusImpl(this.moduleCtx)
  }
  @callable()
  async getKataStatus() {
    return getKataStatusImpl(this.moduleCtx)
  }
}
