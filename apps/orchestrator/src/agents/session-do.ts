import type {
  BranchInfoRow,
  MessagesFrame,
  MessagesPayload,
  SessionMessage as WireSessionMessage,
} from '@duraclaw/shared-types'
import { Agent, type Connection, type ConnectionContext, callable } from 'agents'
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'
import { Session } from 'agents/experimental/memory/session'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import { agentSessions, worktreeReservations } from '~/db/schema'
import { generateActionToken } from '~/lib/action-token'
import { broadcastSyncedDelta } from '~/lib/broadcast-synced-delta'
import { buildChainRow } from '~/lib/chains'
import { runMigrations } from '~/lib/do-migrations'
import { contentToParts, transcriptUserContentToParts } from '~/lib/message-parts'
import { type PushPayload, sendPushNotification } from '~/lib/push'
import { sendFcmNotification } from '~/lib/push-fcm'
import type {
  ContentBlock,
  ContextUsage,
  Env,
  GateResponse,
  GatewayCommand,
  GatewayEvent,
  KataSessionState,
  SessionStatus,
  SpawnConfig,
} from '~/lib/types'
import { getSessionStatus, killSession, listSessions, parseEvent } from '~/lib/vps-client'
import {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  mergeFinalAssistantParts,
  partialAssistantToParts,
} from './gateway-event-mapper'
import {
  buildGatewayCallbackUrl,
  buildGatewayStartUrl,
  claimSubmitId,
  constantTimeEquals,
  findPendingGatePart,
  getGatewayConnectionId,
  loadTurnState,
  resolveStaleThresholdMs,
} from './session-do-helpers'
import { SESSION_DO_MIGRATIONS } from './session-do-migrations'

/**
 * Internal meta shape — replaces the old public `SessionState` type (#31
 * B10). Fields that are durable across DO rehydrate are persisted to the
 * typed `session_meta` SQLite table (migration v7); transient fields
 * (`updated_at`, `active_callback_token`) stay in the setState JSON blob.
 *
 * Nothing outside session-do.ts should reference this shape — clients now
 * derive status / gate from messages and read summary / cost / turns from
 * D1 via REST.
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
  gate: {
    id: string
    type: 'permission_request' | 'ask_user'
    detail: unknown
  } | null
  created_at: string
  updated_at: string
  result: string | null
  error: string | null
  summary: string | null
  sdk_session_id: string | null
  active_callback_token?: string
  lastKataMode?: string
}

/**
 * How often `messageSeq` is persisted to `session_meta`. Set > 1 so streaming
 * `partial_assistant` frames don't trigger per-frame SQL writes; the persisted
 * seq is only consulted on DO rehydrate after eviction, where reconnecting
 * clients fetch a snapshot anyway.
 */
const MESSAGE_SEQ_PERSIST_EVERY = 10

const DEFAULT_META: SessionMeta = {
  status: 'idle',
  session_id: null,
  project: '',
  project_path: '',
  model: null,
  prompt: '',
  userId: null,
  started_at: null,
  completed_at: null,
  num_turns: 0,
  total_cost_usd: null,
  duration_ms: null,
  gate: null,
  created_at: '',
  updated_at: '',
  result: null,
  error: null,
  summary: null,
  sdk_session_id: null,
  active_callback_token: undefined,
}

// Map `SessionMeta` keys to their `session_meta` column names. Keys not in
// this map are treated as non-persistent (e.g. `result`, `updated_at` —
// `updated_at` is written explicitly below; `result` is legacy).
const META_COLUMN_MAP: Partial<Record<keyof SessionMeta, string>> = {
  status: 'status',
  session_id: 'session_id',
  project: 'project',
  project_path: 'project_path',
  model: 'model',
  prompt: 'prompt',
  userId: 'user_id',
  started_at: 'started_at',
  completed_at: 'completed_at',
  num_turns: 'num_turns',
  total_cost_usd: 'total_cost_usd',
  duration_ms: 'duration_ms',
  gate: 'gate_json',
  created_at: 'created_at',
  error: 'error',
  summary: 'summary',
  sdk_session_id: 'sdk_session_id',
  active_callback_token: 'active_callback_token',
  lastKataMode: 'last_kata_mode',
}

/**
 * SessionDO — one Durable Object per CC session.
 *
 * Implements bidirectional relay:
 *   Browser WS <-> SessionDO <-> Gateway WS
 *
 * Persists messages via Session class (agents/experimental/memory/session).
 * Uses @callable RPC methods for spawn, resolveGate, sendMessage, etc.
 */
/**
 * How often the watchdog alarm fires while a session is "running" (ms).
 * Also serves as the keepalive ping interval — alarms survive DO hibernation,
 * unlike setInterval which stops when the DO is evicted from memory.
 */
const WATCHDOG_INTERVAL_MS = 30_000

/**
 * Parse a canonical user-turn ordinal from a message id or canonical_turn_id.
 * Returns `N` if the id matches `/^usr-(\d+)$/`, otherwise `undefined`.
 * Used by DO cold-start turnCounter recovery (GH#14 P3) and the client
 * sort-key derivation.
 */
function parseTurnOrdinal(id?: string): number | undefined {
  if (!id) return undefined
  const m = /^usr-(\d+)$/.exec(id)
  return m ? Number.parseInt(m[1], 10) : undefined
}

// Stale threshold is resolved per-alarm via resolveStaleThresholdMs(env) so
// config changes take effect on the next DO wake without a code change.
// Default is 90s — see DEFAULT_STALE_THRESHOLD_MS in session-do-helpers.

export class SessionDO extends Agent<Env, SessionMeta> {
  initialState = DEFAULT_META
  private session!: Session
  private turnCounter = 0
  private currentTurnMessageId: string | null = null
  /** Cached gateway connection ID — avoids SQLite reads on every message. */
  private cachedGatewayConnId: string | null = null
  /** Timestamp of the last gateway event received on the WS connection. */
  private lastGatewayActivity = 0
  /** Per-session monotonic sequence for MessagesFrame broadcasts (B1). Persisted in typed `session_meta.message_seq`; survives DO rehydrate. */
  private messageSeq = 0
  /**
   * P3 B4: single-flight in-flight probe for `getContextUsage`. Concurrent
   * callers await the same promise; cleared on settle (resolve / reject /
   * timeout) so the next caller can issue a fresh probe.
   */
  private contextUsageProbeInFlight: Promise<ContextUsage | null> | null = null
  /**
   * P3 B4: pending resolvers for the next `context_usage` gateway_event. The
   * handler in `handleGatewayEvent` drains them on arrival. Multiple entries
   * exist only transiently when the probe times out and a new probe races in
   * before the timed-out resolver is swept — the timeout path removes its
   * own slot so late arrivals don't leak.
   */
  private contextUsageResolvers: Array<{
    resolve: (v: ContextUsage | null) => void
    reject: (e: unknown) => void
  }> = []

  // ── Lifecycle ──────────────────────────────────────────────────

  async onStart() {
    runMigrations(this.ctx.storage.sql, SESSION_DO_MIGRATIONS)

    // Rehydrate per-session monotonic seq from typed session_meta (B1). The
    // v6 migration INSERT OR IGNOREs row id=1 so the `?? 0` is belt-and-
    // suspenders. Must run before any code path that can broadcastMessages.
    const metaRows = this.sql<{
      message_seq: number
    }>`SELECT message_seq FROM session_meta WHERE id = 1`
    this.messageSeq = metaRows[0]?.message_seq ?? 0

    // Rehydrate ex-SessionState fields from `session_meta` (#31 B10). Merges
    // into the existing state blob so we pick up newly-persisted columns
    // while preserving any transient fields the setState JSON still holds.
    this.hydrateMetaFromSql()

    this.session = Session.create(this)

    // Trigger Session's lazy table initialization (creates assistant_config etc.)
    // before we query those tables directly via this.sql.
    const pathLength = this.session.getPathLength()

    // Load persisted turn state from assistant_config
    const turnState = loadTurnState(this.sql.bind(this), pathLength)
    this.turnCounter = turnState.turnCounter
    this.currentTurnMessageId = turnState.currentTurnMessageId

    // Guard against DO eviction: if SQLite history survived but the
    // persisted turnCounter is 0 or stale, scan user-turn rows for the
    // max ordinal. Prevents canonical-ID collisions (GH#14 P3 B6).
    try {
      const history = this.session.getHistory()
      let maxOrdinal = 0
      for (const msg of history) {
        const canonical = (msg as { canonical_turn_id?: string }).canonical_turn_id
        const ord = parseTurnOrdinal(canonical) ?? parseTurnOrdinal(msg.id)
        if (ord !== undefined && ord > maxOrdinal) maxOrdinal = ord
      }
      if (maxOrdinal > this.turnCounter) {
        this.turnCounter = maxOrdinal
      }
    } catch {
      // History scan is best-effort; never fatal on cold start.
    }

    // Populate gateway connection ID cache (in case we're waking from hibernation)
    this.cachedGatewayConnId = getGatewayConnectionId(this.sql.bind(this))
  }

  /**
   * Handle HTTP requests to the DO. The API route sends POST /create
   * to initialize and spawn a session without requiring a WS connection.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/create') {
      try {
        const body = (await request.json()) as SpawnConfig & {
          userId?: string
          sdk_session_id?: string
          project_path?: string
        }
        const userId = request.headers.get('x-user-id') ?? body.userId ?? null
        if (userId) {
          this.updateState({ userId })
        }

        let result: { ok: boolean; session_id?: string; error?: string }
        if (body.sdk_session_id) {
          // Resume a discovered session
          result = await this.resumeDiscovered(body, body.sdk_session_id)
        } else {
          result = await this.spawn(body)
        }
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // Raw message history from the DO's SQLite — for auditing persisted parts
    // (e.g. verifying whether a `tool-ask_user` gate part was ever appended).
    // No gateway hydration: we want exactly what's in local history, nothing
    // merged in from the runner transcript.
    if (request.method === 'GET' && url.pathname === '/messages') {
      try {
        // Include the current `messageSeq` alongside history so the client
        // queryFn can stamp each REST-loaded row with a `seq` equal to the
        // latest version. Without this, REST rows land with `seq=undefined`
        // and the query-db-collection diff reconcile clobbers any seq values
        // the on-connect WS snapshot already wrote (causing the initial-load
        // "user messages grouped together" flash — rows fall back to the
        // `[Infinity, turnOrdinal, createdAt]` sort branch).
        return new Response(
          JSON.stringify({
            messages: this.session.getHistory(),
            version: this.messageSeq,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        )
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // P3: REST scaffolding for contextUsage (B4). Returns cached value when
    // fresh (<5s), probes the gateway when stale-or-missing, falls back to
    // stale/null when the runner is disconnected.
    if (request.method === 'GET' && url.pathname === '/context-usage') {
      try {
        const body = await this.getContextUsage()
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // P3: REST scaffolding for kataState (B5). Reads the D1 mirror (source
    // of truth) so the route returns a value even when the runner is dead.
    if (request.method === 'GET' && url.pathname === '/kata-state') {
      try {
        const body = await this.getKataState()
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    // Delegate to Agent base class for WS upgrades and other routes
    return super.onRequest(request)
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url)
    const role = url.searchParams.get('role')

    if (role === 'gateway') {
      // Gateway connection: validate per-dial callback_token minted in
      // triggerGatewayDial. Timing-safe compare; leave token in state so
      // subsequent reconnects by the same session-runner succeed.
      const token = url.searchParams.get('token')
      const active = this.state.active_callback_token
      if (!token || !active || !constantTimeEquals(token, active)) {
        connection.close(4401, 'invalid callback token')
        return
      }

      // Persist gateway connection ID in SQLite (survives hibernation)
      // Do NOT use connection.setState — it conflicts with Agent SDK internals
      this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('gateway_conn_id', ${connection.id})`
      this.cachedGatewayConnId = connection.id
      this.lastGatewayActivity = Date.now()
      console.log(`[SessionDO:${this.ctx.id}] Gateway connected: conn=${connection.id}`)
      return // No replay, no protocol messages
    }

    // Browser connection: replay full message history. Always send the frame
    // (even empty) so the client has an explicit "history fetched" signal and
    // doesn't sit gated waiting for a snapshot that would never arrive for a
    // session with no local history. If the DO is cold and has nothing in
    // SQLite yet, the client's getMessages RPC will trigger gateway-side
    // hydration as the source of truth.
    try {
      const messages = this.session.getHistory()
      // Targeted reconnect snapshot (B1 + B2 single-client scope). The
      // legacy `{type:'messages', messages}` emit was retired in P1
      // sub-phase 1b; the unified frame carries the reconnect payload.
      // B7: include branchInfo for every user turn with siblings so the
      // client's branch-info collection hydrates on first paint.
      this.broadcastMessages(
        {
          kind: 'snapshot',
          version: this.messageSeq,
          messages: messages as unknown as WireSessionMessage[],
          reason: 'reconnect',
          branchInfo: this.computeBranchInfo(messages),
        },
        { targetClientId: connection.id },
      )
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to replay history:`, err)
      // Explicit empty-history snapshot so the client isn't left without a
      // "history fetched" signal on the error path.
      this.broadcastMessages(
        {
          kind: 'snapshot',
          version: this.messageSeq,
          messages: [],
          reason: 'reconnect',
        },
        { targetClientId: connection.id },
      )
    }

    // Re-emit gate if session is waiting
    if (this.state.gate && this.state.status === 'waiting_gate') {
      connection.send(
        JSON.stringify({
          type: 'gateway_event',
          event: {
            type: this.state.gate.type,
            tool_call_id: this.state.gate.id,
            ...(this.state.gate.detail as Record<string, unknown>),
          },
        }),
      )
    }
  }

  /**
   * Suppress all Agent SDK protocol messages (`cf_agent_state`, identity,
   * MCP) for every connection (spec #31 B9). The messages channel is the
   * sole live-state source — status/gate/result are derived client-side via
   * `useDerivedStatus` / `useDerivedGate`; `contextUsage` / `kataState` are
   * served via REST. Returning `false` here silences the legacy state
   * broadcast that the new architecture doesn't consume.
   */
  shouldSendProtocolMessages(_connection: Connection, _ctx: ConnectionContext): boolean {
    return false
  }

  onMessage(connection: Connection, data: string | ArrayBuffer) {
    // Check if this is from the gateway connection
    const gwConnId = this.getGatewayConnectionId()
    if (gwConnId && connection.id === gwConnId) {
      // Gateway message: parse and route to handleGatewayEvent
      this.lastGatewayActivity = Date.now()
      try {
        const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
        const event = parseEvent(raw)
        this.handleGatewayEvent(event)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to parse gateway message:`, err)
      }
      return
    }

    // Browser message: delegate to Agent base class for @callable RPC dispatch
    super.onMessage(connection, data)
  }

  onClose(connection: Connection, code: number, reason: string, _wasClean: boolean) {
    const gwConnId = this.getGatewayConnectionId()
    if (gwConnId && connection.id === gwConnId) {
      console.log(`[SessionDO:${this.ctx.id}] Gateway WS closed: code=${code} reason=${reason}`)
      // Clear the persisted gateway connection ID
      this.cachedGatewayConnId = null
      try {
        this.sql`DELETE FROM kv WHERE key = 'gateway_conn_id'`
      } catch {
        /* ignore */
      }

      // If session was active, the connection dropped unexpectedly. Ask the
      // gateway for the runner's live state before running the local recovery
      // path — if the runner is still alive, its DialBackClient will reconnect
      // and we should wait rather than finalizing the DO prematurely.
      if (this.state.status === 'running' || this.state.status === 'waiting_gate') {
        this.maybeRecoverAfterGatewayDrop().catch((err) => {
          console.error(`[SessionDO:${this.ctx.id}] maybeRecoverAfterGatewayDrop failed:`, err)
        })
      }
    }

    super.onClose(connection, code, reason, _wasClean)
  }

  /**
   * Implements B7 (status-aware recovery). Called from `onClose` for the
   * gateway-role connection. Probes `GET /sessions/:id/status` with a 5s
   * timeout and decides whether to finalize the DO or wait for a re-dial.
   *
   * Defensive fallback: on any unreachable / non-200 / non-404 result, run
   * `recoverFromDroppedConnection` as the DO cannot trust the gateway's
   * liveness signal.
   */
  private async maybeRecoverAfterGatewayDrop() {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    const sessionId = this.state.session_id
    if (!gatewayUrl || !sessionId) {
      await this.recoverFromDroppedConnection()
      return
    }

    const result = await getSessionStatus(gatewayUrl, this.env.CC_GATEWAY_SECRET, sessionId, 5_000)

    if (result.kind === 'state') {
      if (result.body.state === 'running') {
        console.log(`[SessionDO:${this.ctx.id}] WS dropped, runner alive — skipping recovery`)
        return
      }
      console.log(
        `[SessionDO:${this.ctx.id}] WS dropped, runner terminal (${result.body.state}) — running recovery`,
      )
      await this.recoverFromDroppedConnection()
      return
    }

    if (result.kind === 'not_found') {
      console.log(`[SessionDO:${this.ctx.id}] WS dropped, gateway 404 — running recovery (orphan)`)
      await this.recoverFromDroppedConnection()
      return
    }

    console.log(
      `[SessionDO:${this.ctx.id}] WS dropped, status unreachable (${result.reason}) — running recovery (defensive)`,
    )
    await this.recoverFromDroppedConnection()
  }

  // ── Gateway Connection ─────────────────────────────────────────

  /**
   * Trigger the gateway to dial back into this DO via outbound WS.
   *
   * Lifecycle per B4b:
   *   1. Mint a fresh callback_token (UUID v4).
   *   2. If a previous token was active, close any live gateway-role WS with
   *      code 4410 ("token rotated") BEFORE persisting the new token — this
   *      prevents an old session-runner from continuing to stream into the DO
   *      concurrently with the newly-spawned runner.
   *   3. Persist the new token via setState (JSON blob — no migration).
   *   4. POST /sessions/start with {callback_url, callback_token, cmd}.
   *   5. On success, persist the gateway-assigned session_id.
   */
  private async triggerGatewayDial(cmd: GatewayCommand) {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    const workerPublicUrl = this.env.WORKER_PUBLIC_URL
    if (!gatewayUrl || !workerPublicUrl) {
      console.error(`[SessionDO:${this.ctx.id}] CC_GATEWAY_URL or WORKER_PUBLIC_URL not configured`)
      this.updateState({ status: 'idle', error: 'Gateway URL or Worker URL not configured' })
      return
    }

    const callback_token = crypto.randomUUID()

    // Ordering invariant: close the old gateway WS FIRST, then rotate the
    // token via updateState, then POST. If onClose races us during this
    // window, maybeRecoverAfterGatewayDrop probes gateway status — it does
    // not read active_callback_token directly, so a stale token in state
    // cannot cause a wrong branch. The close-first-then-rotate order
    // matters anyway so a reconnect from the old runner can't slip in
    // between the token swap and the POST.
    // Rotate: close any existing gateway-role WS on this DO with 4410 before
    // storing the new token so old+new runners don't both stream to the DO.
    if (this.state.active_callback_token) {
      const oldConnId = this.getGatewayConnectionId()
      if (oldConnId) {
        for (const conn of this.getConnections()) {
          if (conn.id === oldConnId) {
            try {
              conn.close(4410, 'token rotated')
            } catch (err) {
              console.error(`[SessionDO:${this.ctx.id}] Failed to close old gateway WS:`, err)
            }
            break
          }
        }
        // Clear the connection-id cache; onClose will also clear but the new
        // runner should not find a stale id in the meantime.
        this.cachedGatewayConnId = null
        try {
          this.sql`DELETE FROM kv WHERE key = 'gateway_conn_id'`
        } catch {
          /* ignore */
        }
      }
    }

    this.updateState({ active_callback_token: callback_token })

    // Build callback URL: wss://worker-url/agents/session-agent/<do-id>?role=gateway&token=<token>
    const callbackUrl = buildGatewayCallbackUrl(
      workerPublicUrl,
      this.ctx.id.toString(),
      callback_token,
    )

    // POST to gateway to trigger dial-back
    const startUrl = buildGatewayStartUrl(gatewayUrl)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.env.CC_GATEWAY_SECRET) {
        headers.Authorization = `Bearer ${this.env.CC_GATEWAY_SECRET}`
      }

      const resp = await fetch(startUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ callback_url: callbackUrl, callback_token, cmd }),
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'unknown error')
        console.error(`[SessionDO:${this.ctx.id}] Gateway start failed: ${resp.status} ${errText}`)
        this.updateState({ status: 'idle', error: `Gateway start failed: ${resp.status}` })
        return
      }

      // Persist the gateway-assigned session_id so subsequent /sessions/:id/status
      // calls use the gateway's canonical id (distinct from the DO id).
      try {
        const parsed = (await resp.json()) as { ok?: boolean; session_id?: string }
        if (parsed?.session_id) {
          this.updateState({ session_id: parsed.session_id })
        }
      } catch (err) {
        console.error(
          `[SessionDO:${this.ctx.id}] Failed to parse gateway /sessions/start body:`,
          err,
        )
      }

      this.lastGatewayActivity = Date.now()
      this.scheduleWatchdog()
      console.log(`[SessionDO:${this.ctx.id}] triggerGatewayDial: POST to gateway succeeded`)
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Gateway start POST failed:`, err)
      this.updateState({
        status: 'idle',
        error: `Gateway start failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /** Schedule the next watchdog alarm. */
  private scheduleWatchdog() {
    this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS)
  }

  /**
   * DO alarm handler — watchdog for stale gateway connections.
   *
   * Fires periodically while a session is "running". If no gateway events
   * have arrived recently and the WS is gone, attempt recovery.
   */
  async alarm() {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return // Session not active, no need to watch
    }

    const staleDuration = Date.now() - this.lastGatewayActivity
    const gwConnId = this.getGatewayConnectionId()
    const staleThreshold = resolveStaleThresholdMs(this.env.STALE_THRESHOLD_MS)

    if (staleDuration > staleThreshold && !gwConnId) {
      console.log(
        `[SessionDO:${this.ctx.id}] Watchdog: stale for ${Math.round(staleDuration / 1000)}s with no gateway connection — recovering (threshold=${staleThreshold}ms)`,
      )
      await this.recoverFromDroppedConnection()
      return
    }

    // Still active, schedule next check
    this.scheduleWatchdog()
  }

  /**
   * Attempt to recover session state after the gateway WS dropped.
   *
   * Polls the gateway HTTP API for the latest session transcript,
   * syncs any missed messages, and transitions to the correct status.
   */
  private async recoverFromDroppedConnection() {
    // Sync any missed messages from the gateway transcript
    try {
      await this.hydrateFromGateway()
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Recovery hydration failed:`, err)
    }

    // Finalize any streaming parts
    if (this.currentTurnMessageId) {
      const existing = this.session.getMessage(this.currentTurnMessageId)
      if (existing) {
        const finalizedParts = finalizeStreamingParts(existing.parts)
        this.session.updateMessage({ ...existing, parts: finalizedParts })
        this.broadcastMessage({ ...existing, parts: finalizedParts })
      }
      this.currentTurnMessageId = null
      this.persistTurnState()
    }

    // Transition to idle (session may be resumable via sdk_session_id).
    // Clear active_callback_token — the runner that owned it is gone.
    this.updateState({
      status: 'idle',
      gate: null,
      error: 'Gateway connection lost — session stopped. You can send a new message to resume.',
      active_callback_token: undefined,
    })
    this.syncStatusToD1(new Date().toISOString())

    // Notify connected clients
    this.broadcastToClients(
      JSON.stringify({
        type: 'gateway_event',
        event: { type: 'result', is_error: false, result: 'Connection lost — session idle' },
      }),
    )

    console.log(`[SessionDO:${this.ctx.id}] Recovery: transitioned to idle`)
  }

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Patch-merge into the Agent's state blob and mirror the durable subset
   * into `session_meta` (migration v7). Fields without a column mapping
   * (e.g. `updated_at`, `result`) stay only in the in-memory JSON blob —
   * clients no longer consume them and DO rehydrate pulls from SQLite.
   */
  private updateState(partial: Partial<SessionMeta>) {
    this.setState({
      ...this.state,
      ...partial,
      updated_at: new Date().toISOString(),
    })
    this.persistMetaPatch(partial)
  }

  private persistMetaPatch(partial: Partial<SessionMeta>) {
    const cols: string[] = []
    const vals: unknown[] = []
    for (const [key, value] of Object.entries(partial) as Array<
      [keyof SessionMeta, SessionMeta[keyof SessionMeta]]
    >) {
      const col = META_COLUMN_MAP[key]
      if (!col) continue
      if (key === 'gate') {
        cols.push(`${col} = ?`)
        vals.push(value ? JSON.stringify(value) : null)
      } else {
        cols.push(`${col} = ?`)
        vals.push(value ?? null)
      }
    }
    if (cols.length === 0) return
    cols.push('updated_at = ?')
    vals.push(Date.now())
    try {
      this.ctx.storage.sql.exec(
        `UPDATE session_meta SET ${cols.join(', ')} WHERE id = 1`,
        ...(vals as (string | number | null)[]),
      )
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] persistMetaPatch failed:`, err)
    }
  }

  /**
   * Rehydrate `this.state` from `session_meta` on onStart (#31 P5). Agent's
   * initialState seed runs once on first wake; on subsequent rehydrates the
   * setState JSON blob is lost if the DO was evicted without a setState
   * call in the final turn — restoring from SQLite keeps `project`,
   * `status`, `session_id`, etc. intact for the next caller.
   */
  private hydrateMetaFromSql() {
    try {
      const rows = this.sql<Record<string, unknown>>`SELECT * FROM session_meta WHERE id = 1`
      const row = rows[0]
      if (!row) return
      const patch: Partial<SessionMeta> = {}
      for (const [key, col] of Object.entries(META_COLUMN_MAP) as Array<
        [keyof SessionMeta, string]
      >) {
        if (!(col in row)) continue
        const raw = row[col]
        if (raw === null || raw === undefined) continue
        if (key === 'gate') {
          try {
            ;(patch as Record<string, unknown>)[key] =
              typeof raw === 'string' ? JSON.parse(raw) : raw
          } catch {
            // Invalid gate JSON — skip.
          }
        } else {
          ;(patch as Record<string, unknown>)[key] = raw
        }
      }
      if (Object.keys(patch).length === 0) return
      this.setState({
        ...this.state,
        ...patch,
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] hydrateMetaFromSql failed:`, err)
    }
  }

  private broadcastToClients(data: string) {
    const gwConnId = this.getGatewayConnectionId()
    for (const conn of this.getConnections()) {
      if (conn.id === gwConnId) continue // Skip gateway connection
      try {
        conn.send(data)
      } catch {
        // Connection already closed
      }
    }
  }

  private broadcastGatewayEvent(event: GatewayEvent) {
    this.broadcastToClients(JSON.stringify({ type: 'gateway_event', event }))
  }

  /**
   * Push per-turn summary counters to connected clients.
   *
   * Background: spec #31 deleted the SessionState WS broadcast
   * (`shouldSendProtocolMessages() => false`) and removed the client's
   * `result` gateway_event handler on the assumption that
   * numTurns / totalCostUsd / durationMs would land via the REST fallback.
   * In practice `backfillFromRest` only fires on mount / WS reconnect /
   * window focus, so during a live session the StatusBar's "X turns"
   * counter sat at 0 forever. Push a typed `session_summary` frame on
   * every in-DO counter mutation (`assistant` and `result` events) so the
   * client can upsert `sessionLiveStateCollection` without waiting for a
   * REST round-trip. Retired once spec #35 lands an `agent_sessions`
   * synced collection that drives these fields from D1 deltas.
   */
  private broadcastSessionSummary() {
    this.broadcastToClients(
      JSON.stringify({
        type: 'session_summary',
        sessionId: this.state.session_id ?? this.ctx.id.toString(),
        summary: {
          numTurns: this.state.num_turns,
          totalCostUsd: this.state.total_cost_usd ?? null,
          durationMs: this.state.duration_ms ?? null,
        },
      }),
    )
  }

  private broadcastMessage(message: SessionMessage) {
    // Unified {type:'messages'} delta frame (B1). The legacy per-message
    // `{type:'message'}` emit was retired in P1 sub-phase 1b now that the
    // client dispatches exclusively on the unified shape.
    this.broadcastMessages({ kind: 'delta', upsert: [message as unknown as WireSessionMessage] })
  }

  /**
   * Compute `BranchInfoRow[]` for every user turn in the given linear history
   * that has siblings (> 1 user-message branch under the same parent).
   *
   * Parent resolution: the Session API (`agents/experimental/memory/session`)
   * exposes `getBranches(messageId)` but no `getParent()`. We derive the
   * parent from the ordering of the linear history — the message immediately
   * preceding a user turn on the active branch is its parent. Turns with no
   * preceding message (the first turn) are skipped.
   *
   * Rows with `siblings.length <= 1` are omitted — the client's
   * `useBranchInfo` only shows arrows when `total > 1` anyway, and this
   * keeps the payload small.
   *
   * See GH#14 B7.
   */
  private computeBranchInfo(history: SessionMessage[]): BranchInfoRow[] {
    const rows: BranchInfoRow[] = []
    const nowIso = new Date().toISOString()
    for (let i = 0; i < history.length; i++) {
      const msg = history[i]
      if (msg.role !== 'user') continue
      const parentId = i > 0 ? history[i - 1].id : null
      if (!parentId) continue
      try {
        const branches = this.session.getBranches(parentId)
        const siblings = branches.filter((m) => m.role === 'user').map((m) => m.id)
        if (siblings.length <= 1) continue
        rows.push({
          parentMsgId: parentId,
          sessionId: this.name,
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
   * sendMessage / forkWithHistory to piggyback branch-info onto the user-turn
   * delta (P2 B2).
   */
  private computeBranchInfoForUserTurn(msg: SessionMessage): BranchInfoRow | undefined {
    try {
      const history = this.session.getHistory()
      const idx = history.findIndex((m) => m.id === msg.id)
      if (idx <= 0) return undefined
      const parentId = history[idx - 1].id
      const branches = this.session.getBranches(parentId)
      const siblings = branches.filter((m) => m.role === 'user').map((m) => m.id)
      if (siblings.length <= 1) return undefined
      return {
        parentMsgId: parentId,
        sessionId: this.name,
        siblings,
        activeId: msg.id,
        updatedAt: new Date().toISOString(),
      }
    } catch {
      return undefined
    }
  }

  /**
   * Broadcast a MessagesFrame (B1) with monotonic seq. If `targetClientId` is
   * provided, sends only to that connection and does NOT increment `messageSeq`
   * — targeted sends echo current seq so non-recipients' lastSeq stream stays
   * aligned (see spec B2 API Layer → "Targeted snapshots MUST NOT advance the
   * shared seq counter").
   */
  private broadcastMessages(payload: MessagesPayload, opts: { targetClientId?: string } = {}) {
    if (!opts.targetClientId) {
      this.messageSeq += 1
      // Persist only every Nth increment — per-frame SQL writes during streaming
      // `partial_assistant` turns are wasteful, and the persisted seq is only
      // consulted on DO eviction / rehydrate, where clients reconnect with a
      // snapshot anyway (frame-level precision unnecessary).
      if (this.messageSeq % MESSAGE_SEQ_PERSIST_EVERY === 0) {
        this
          .sql`UPDATE session_meta SET message_seq = ${this.messageSeq}, updated_at = ${Date.now()} WHERE id = 1`
      }
    }
    const frame: MessagesFrame = {
      type: 'messages',
      sessionId: this.name,
      seq: this.messageSeq,
      payload,
    }
    const data = JSON.stringify(frame)
    if (opts.targetClientId) {
      this.sendToClient(opts.targetClientId, data)
    } else {
      this.broadcastToClients(data)
    }
  }

  /** Send raw stringified payload to a specific client connection (skips gateway conn). */
  private sendToClient(connectionId: string, data: string) {
    const gwConnId = this.getGatewayConnectionId()
    for (const conn of this.getConnections()) {
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
   * Promote an existing tool-use part (created by the `assistant` event) to a
   * gate part so the UI renders a GateResolver instead of a plain tool pill.
   *
   * Scans ALL messages (latest first) for a part whose `toolCallId` matches,
   * then flips its `type`, `toolName`, and `state` in place.  This avoids the
   * old approach of appending a *second* part via a message-ID lookup that
   * could miss when `turnCounter` drifted between the `assistant` and gate
   * events.
   *
   * If no matching part is found (edge case: the `assistant` event hasn't
   * been processed yet, or was lost), a standalone assistant message is
   * created as a fallback so the gate is never silently dropped.
   */
  private promoteToolPartToGate(
    toolCallId: string,
    newType: string,
    newToolName: string,
    input: Record<string, unknown>,
  ) {
    // Walk messages newest-first looking for the part the assistant event
    // already created (type = `tool-{SdkToolName}`, toolCallId matches).
    const history = this.session.getHistory()
    let promoted = false
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      const idx = msg.parts.findIndex((p) => p.toolCallId === toolCallId)
      if (idx === -1) continue

      const updatedParts = [...msg.parts]
      updatedParts[idx] = {
        ...updatedParts[idx],
        type: newType,
        toolName: newToolName,
        input: updatedParts[idx].input ?? input, // keep SDK input if present
        state: 'approval-requested',
      }
      const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
      try {
        this.session.updateMessage(updatedMsg)
        this.broadcastMessage(updatedMsg)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to promote gate part:`, err)
        this.broadcastToClients(
          JSON.stringify({ type: 'raw_event', event: { type: newType, tool_call_id: toolCallId } }),
        )
      }
      promoted = true
      break
    }

    // Fallback: assistant event hasn't created the part yet — create a
    // standalone message so the gate is never invisible.
    if (!promoted) {
      console.warn(
        `[SessionDO:${this.ctx.id}] promoteToolPartToGate: no part with toolCallId '${toolCallId}' — creating standalone gate message`,
      )
      const gateMsg: SessionMessage = {
        id: `gate-${toolCallId}`,
        role: 'assistant',
        parts: [
          {
            type: newType,
            toolCallId,
            toolName: newToolName,
            input,
            state: 'approval-requested',
          },
        ],
        createdAt: new Date(),
      }
      try {
        void this.session.appendMessage(gateMsg)
        this.broadcastMessage(gateMsg)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to create standalone gate:`, err)
      }
    }
  }

  private persistTurnState() {
    try {
      this
        .sql`INSERT OR REPLACE INTO assistant_config (session_id, key, value) VALUES ('', 'turnCounter', ${String(this.turnCounter)})`
      this
        .sql`INSERT OR REPLACE INTO assistant_config (session_id, key, value) VALUES ('', 'currentTurnMessageId', ${this.currentTurnMessageId ?? ''})`
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to persist turn state:`, err)
    }
  }

  /**
   * Drizzle handle scoped to this DO's request env. Lazy-init per call so
   * the binding is always fresh. As of #7 p6 D1 is the sole metadata
   * source of truth — the previous SESSION_REGISTRY DO fan-out is gone.
   */
  private get d1() {
    return drizzle(this.env.AUTH_DB, { schema })
  }

  private async syncStatusToD1(updatedAt: string) {
    try {
      const sessionId = this.state.session_id ?? this.ctx.id.toString()
      await this.d1
        .update(agentSessions)
        .set({ status: this.state.status, updatedAt, lastActivity: updatedAt })
        .where(eq(agentSessions.id, sessionId))
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync status to D1:`, err)
    }
  }

  private async syncResultToD1(updatedAt: string) {
    try {
      const sessionId = this.state.session_id ?? this.ctx.id.toString()
      await this.d1
        .update(agentSessions)
        .set({
          summary: this.state.summary,
          durationMs: this.state.duration_ms,
          totalCostUsd: this.state.total_cost_usd,
          numTurns: this.state.num_turns,
          updatedAt,
          lastActivity: updatedAt,
        })
        .where(eq(agentSessions.id, sessionId))
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync result to D1:`, err)
    }
  }

  private async syncSdkSessionIdToD1(sdkSessionId: string, updatedAt: string) {
    try {
      const sessionId = this.state.session_id ?? this.ctx.id.toString()
      await this.d1
        .update(agentSessions)
        .set({ sdkSessionId, updatedAt })
        .where(eq(agentSessions.id, sessionId))
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync sdk_session_id to D1:`, err)
    }
  }

  private async syncKataToD1(kataState: KataSessionState | null, updatedAt: string) {
    try {
      const sessionId = this.state.session_id ?? this.ctx.id.toString()
      await this.d1
        .update(agentSessions)
        .set({
          kataMode: kataState?.currentMode ?? null,
          kataIssue: kataState?.issueNumber ?? null,
          kataPhase: kataState?.currentPhase ?? null,
          updatedAt,
        })
        .where(eq(agentSessions.id, sessionId))
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync kata to D1:`, err)
    }

    // Chain UX B11: refresh the worktree reservation's last_activity_at on
    // every kata_state event so stale gating (7-day inactivity) tracks real
    // session usage. Also clears a previously-set `stale` flag.
    if (kataState?.issueNumber != null && this.state.project) {
      try {
        await this.d1
          .update(worktreeReservations)
          .set({ lastActivityAt: updatedAt, stale: false })
          .where(
            and(
              eq(worktreeReservations.issueNumber, kataState.issueNumber),
              eq(worktreeReservations.worktree, this.state.project),
            ),
          )
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] failed to refresh reservation activity:`, err)
      }
    }

    // GH#32 phase p5: broadcast an updated `chains` row for the affected
    // issue so connected browsers see status / column / lastActivity
    // updates without polling. Scoped to the session's owning user; a null
    // return from buildChainRow means the chain has emptied — emit a delete
    // so the client collection drops the row.
    this.broadcastChainUpdate(kataState?.issueNumber ?? null)
  }

  /**
   * Rebuild the ChainSummary for `issueNumber` and broadcast the delta op
   * to the owning user's UserSettingsDO. Fire-and-forget via `waitUntil`
   * so D1 write → broadcast latency doesn't stack on the caller.
   */
  private broadcastChainUpdate(issueNumber: number | null) {
    if (issueNumber == null || !Number.isFinite(issueNumber)) return
    const userId = this.state.userId
    if (!userId) return

    this.ctx.waitUntil(
      (async () => {
        try {
          const row = await buildChainRow(this.env, this.d1, userId, issueNumber)
          if (row) {
            await broadcastSyncedDelta(this.env, userId, 'chains', [{ type: 'update', value: row }])
          } else {
            await broadcastSyncedDelta(this.env, userId, 'chains', [
              { type: 'delete', key: String(issueNumber) },
            ])
          }
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] broadcastChainUpdate failed:`, err)
        }
      })(),
    )
  }

  /**
   * Chain UX P4 — mode-enter session reset.
   *
   * Triggered when a chain-linked session observes a `kata_state` event with
   * a different `currentMode` than previously seen and `continueSdk` is not
   * set. Flushes the outbound channel, kicks the active runner WS with close
   * code 4411 (mode_transition), waits up to 5s for the runner to exit, then
   * spawns a fresh runner in the new mode with an artifact-pointer preamble.
   */
  private async handleModeTransition(kataState: KataSessionState, fromMode: string | null) {
    const sessionId = this.state.session_id ?? this.ctx.id.toString()
    const toMode = kataState.currentMode ?? ''
    const issueNumber = kataState.issueNumber ?? 0

    console.log(
      `[SessionDO:${this.ctx.id}] mode transition ${fromMode ?? '(none)'}→${toMode} issue=#${issueNumber}`,
    )

    // 1. Announce the transition to browsers so the chain timeline UI picks it up.
    this.broadcastGatewayEvent({
      type: 'mode_transition',
      session_id: sessionId,
      from: fromMode,
      to: toMode,
      issueNumber,
      at: new Date().toISOString(),
    })

    // 2. Flush window — BufferedChannel has no in-flight-send introspection,
    //    so the best we can do is a short pause to let the runner's final
    //    pre-transition events land before we slam the WS shut.
    await new Promise((r) => setTimeout(r, 2000))

    // 3. Close the runner WS with 4411 (mode_transition). Mirrors the 4410
    //    rotation path in triggerGatewayDial.
    const gwConnId = this.getGatewayConnectionId()
    if (gwConnId) {
      for (const conn of this.getConnections()) {
        if (conn.id === gwConnId) {
          try {
            conn.close(4411, 'mode_transition')
          } catch (err) {
            console.error(
              `[SessionDO:${this.ctx.id}] Failed to close runner WS on mode transition:`,
              err,
            )
          }
          break
        }
      }
      this.cachedGatewayConnId = null
      try {
        this.sql`DELETE FROM kv WHERE key = 'gateway_conn_id'`
      } catch {
        /* ignore */
      }
      // Explicitly clear the callback token so the poll below proceeds on the
      // happy path. onClose only clears this when status is running/waiting_gate,
      // which doesn't cover every mode-transition case — without this clear the
      // poll below always falls through to the 5s timeout.
      this.updateState({ active_callback_token: undefined })
    }

    // 4. Wait up to 5s for the runner to exit — signalled by the DO's onClose
    //    handler clearing `active_callback_token` (or the token rotating to a
    //    new value). Poll state.active_callback_token at 100ms granularity.
    const startTok = this.state.active_callback_token
    const exited = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (value: boolean) => {
        if (settled) return
        settled = true
        clearInterval(interval)
        clearTimeout(timeout)
        resolve(value)
      }
      const check = () => {
        const tok = this.state.active_callback_token
        if (!tok || tok !== startTok) done(true)
      }
      const interval = setInterval(check, 100)
      const timeout = setTimeout(() => done(false), 5000)
      check()
    })

    if (!exited) {
      console.warn(
        `[SessionDO:${this.ctx.id}] mode transition: runner did not exit within 5s — proceeding (token rotation in triggerGatewayDial will evict lingering runner via 4410)`,
      )
      this.broadcastGatewayEvent({
        type: 'mode_transition_timeout',
        session_id: sessionId,
        issueNumber,
        at: new Date().toISOString(),
        note: 'runner did not exit within 5s; proceeding with fresh spawn',
      })
    }

    // 5. Build preamble (degrade gracefully on failure).
    const preamble = await this.buildModePreamble(kataState)

    // 6. Spawn fresh runner in the new mode. triggerGatewayDial handles any
    //    lingering runner via 4410 rotation.
    await this.triggerGatewayDial({
      type: 'execute',
      project: this.state.project,
      prompt: preamble,
      agent: toMode,
      model: this.state.model ?? 'sonnet',
    })
  }

  /**
   * Build the artifact-pointer preamble prepended to the fresh runner's first
   * prompt on a chain mode transition. Queries D1 for prior sessions linked
   * to the same issueNumber and emits a one-line pointer per completed mode.
   * On any failure, falls back to the degraded template from the spec and
   * emits `mode_transition_preamble_degraded` so the UI can surface it.
   */
  private async buildModePreamble(ks: KataSessionState): Promise<string> {
    const issueNumber = ks.issueNumber ?? 0
    const mode = ks.currentMode ?? 'unknown'
    const phase = ks.currentPhase ?? 'p0'
    const sessionId = this.state.session_id ?? this.ctx.id.toString()

    // Issue title is not a first-class field on the DO — leave as 'untitled'
    // until chain metadata plumbing lands (downstream P5 work).
    const issueTitle = 'untitled'

    const degraded = () =>
      `You are entering ${mode} mode for issue #${issueNumber}. Prior-artifact listing is unavailable — use the kata CLI (\`kata status\`) to inspect chain state. Your kata state is already linked: workflowId=GH#${issueNumber}, mode=${mode}, phase=${phase}.`

    try {
      const rows = await this.d1
        .select({
          id: agentSessions.id,
          status: agentSessions.status,
          kataMode: agentSessions.kataMode,
          createdAt: agentSessions.createdAt,
        })
        .from(agentSessions)
        .where(eq(agentSessions.kataIssue, issueNumber))
        .orderBy(asc(agentSessions.createdAt))

      const artifactLines: string[] = []
      for (const row of rows) {
        if (row.status !== 'completed') continue
        const rowMode = row.kataMode ?? 'unknown'
        const idTail = row.id.slice(-8)
        artifactLines.push(`- ${rowMode}: session ${idTail}`)
      }

      const artifacts = artifactLines.length > 0 ? artifactLines.join('\n') : '- (none yet)'

      return `You are entering ${mode} mode for issue #${issueNumber} ("${issueTitle}").

Prior artifacts in this chain:
${artifacts}

Read the relevant artifacts before acting. Your kata state is already linked: workflowId=GH#${issueNumber}, mode=${mode}, phase=${phase}.`
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[SessionDO:${this.ctx.id}] buildModePreamble failed:`, err)
      this.broadcastGatewayEvent({
        type: 'mode_transition_preamble_degraded',
        session_id: sessionId,
        issueNumber,
        at: new Date().toISOString(),
        reason,
      })
      return degraded()
    }
  }

  /**
   * Fetch SDK session transcript from the VPS gateway and persist via Session.
   * Called on first getMessages() for discovered sessions with empty history.
   */
  /**
   * Fetch SDK session transcript from the VPS gateway and persist via Session.
   *
   * Skips the first `skipCount` user/assistant messages that are already
   * persisted locally. When called with skipCount=0 (default) on a session
   * that already has messages, it effectively skips nothing but also doesn't
   * duplicate — the skipCount should match the number of user+assistant
   * messages already in the Session tree.
   */
  private async hydrateFromGateway() {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    if (!gatewayUrl || !this.state.sdk_session_id || !this.state.project) return

    const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const url = new URL(
      `/projects/${encodeURIComponent(this.state.project)}/sessions/${encodeURIComponent(this.state.sdk_session_id)}/messages`,
      httpBase,
    )
    const headers: Record<string, string> = {}
    if (this.env.CC_GATEWAY_SECRET) {
      headers.Authorization = `Bearer ${this.env.CC_GATEWAY_SECRET}`
    }

    try {
      const resp = await fetch(url.toString(), { headers })
      if (!resp.ok) {
        console.error(
          `[SessionDO:${this.ctx.id}] Gateway hydration failed: ${resp.status} ${resp.statusText}`,
        )
        return
      }
      const data = (await resp.json()) as {
        messages: Array<{ type: string; uuid: string; content: unknown[] }>
      }
      if (!data.messages?.length) return

      // Count how many user/assistant messages we already have locally.
      // We skip that many from the gateway transcript to avoid duplicates.
      const localHistory = this.session.getPathLength()
      let skipped = 0

      let persisted = 0
      let lastMsgId: string | null = null
      // Tracks the in-progress assistant message across multi-cycle turns so
      // that consecutive SDK `assistant` events (text → tool_use per cycle)
      // merge into a single local message, matching live-stream behavior.
      // Reset on every `user` event (turn boundary).
      let currentAssistantMsgId: string | null = null

      // If we have local messages, set lastMsgId to the latest one so new
      // messages get appended to the end of the existing tree. If the tail is
      // an assistant message, treat it as the in-progress turn accumulator so
      // new assistant events from the transcript merge into it (multi-cycle
      // turns where live streaming already built a merged message).
      if (localHistory > 0) {
        const history = this.session.getHistory()
        if (history.length > 0) {
          const tail = history[history.length - 1]
          lastMsgId = tail.id
          if (tail.role === 'assistant') {
            currentAssistantMsgId = tail.id
          }
        }
      }

      for (const msg of data.messages) {
        // Skip user/assistant messages we already persisted
        if (msg.type === 'user' || msg.type === 'assistant') {
          if (skipped < localHistory) {
            skipped++
            continue
          }
        }
        // Also skip tool_results that belong to already-persisted messages
        if (msg.type === 'tool_result' && skipped <= localHistory && persisted === 0) {
          continue
        }

        if (msg.type === 'user') {
          // Filter out tool_result blocks from user message content — those are handled
          // as separate tool_result events. If only tool_result blocks remain, skip entirely.
          let content = msg.content
          if (Array.isArray(content)) {
            const filtered = content.filter(
              (c: unknown) => (c as Record<string, unknown>)?.type !== 'tool_result',
            )
            if (filtered.length === 0) {
              // User message contained only tool_result blocks — skip
              continue
            }
            content = filtered
          }

          this.turnCounter++
          const msgId = `usr-${this.turnCounter}`
          const sessionMsg: SessionMessage = {
            id: msgId,
            role: 'user',
            parts: transcriptUserContentToParts(content),
            createdAt: new Date(),
          }
          await this.session.appendMessage(sessionMsg, lastMsgId)
          lastMsgId = msgId
          // A new user message ends any in-progress assistant turn — reset the
          // accumulator so the next assistant event starts a fresh message.
          currentAssistantMsgId = null
          persisted++
        } else if (msg.type === 'assistant') {
          const newParts = assistantContentToParts(msg.content)
          if (currentAssistantMsgId) {
            // Same turn as the previous assistant event (multi-cycle Claude
            // response) — merge parts into the existing message to mirror the
            // live-streaming merge behavior. Otherwise tool pills get split
            // across N messages and lose their grouping in the UI.
            const existing = this.session.getMessage(currentAssistantMsgId)
            if (existing) {
              this.session.updateMessage({
                ...existing,
                parts: [...existing.parts, ...newParts],
              })
              persisted++
              continue
            }
          }
          this.turnCounter++
          const msgId = `msg-${this.turnCounter}`
          const sessionMsg: SessionMessage = {
            id: msgId,
            role: 'assistant',
            parts: newParts,
            createdAt: new Date(),
          }
          await this.session.appendMessage(sessionMsg, lastMsgId)
          lastMsgId = msgId
          currentAssistantMsgId = msgId
          persisted++
        } else if (msg.type === 'tool_result') {
          // Apply tool results to the last assistant message
          if (lastMsgId) {
            const existing = this.session.getMessage(lastMsgId)
            if (existing) {
              const updatedParts = applyToolResult(existing.parts, msg)
              this.session.updateMessage({ ...existing, parts: updatedParts })
            }
          }
          persisted++
        }
      }
      if (persisted > 0) {
        this.persistTurnState()
      }
      console.log(
        `[SessionDO:${this.ctx.id}] Hydrated ${persisted} new events (skipped ${skipped} existing) from gateway for sdk_session=${this.state.sdk_session_id.slice(0, 12)}`,
      )
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Gateway hydration error:`, err)
    }
  }

  private sendToGateway(cmd: GatewayCommand) {
    const gwConnId = this.getGatewayConnectionId()
    if (!gwConnId) {
      console.error(`[SessionDO:${this.ctx.id}] Cannot send to gateway: no active connection`)
      return
    }
    // Find the matching connection from the Hibernation API
    for (const conn of this.getConnections()) {
      if (conn.id === gwConnId) {
        try {
          conn.send(JSON.stringify(cmd))
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to send to gateway:`, err)
        }
        return
      }
    }
    console.error(
      `[SessionDO:${this.ctx.id}] Gateway connection ${gwConnId} not found in active connections`,
    )
  }

  /** Read the gateway connection ID, using in-memory cache when available. */
  private getGatewayConnectionId(): string | null {
    if (this.cachedGatewayConnId) return this.cachedGatewayConnId
    // Fallback to SQLite (e.g. after hibernation wake)
    const id = getGatewayConnectionId(this.sql.bind(this))
    this.cachedGatewayConnId = id
    return id
  }

  private async dispatchPush(payload: PushPayload, eventType: 'blocked' | 'completed' | 'error') {
    const tag = `[push:dispatch ${this.ctx.id}]`
    const userId = this.state.userId
    if (!userId) {
      console.log(`${tag} no userId on state — skipping`)
      return
    }

    console.log(
      `${tag} begin`,
      JSON.stringify({
        eventType,
        url: payload.url,
        tag: payload.tag,
        sessionId: payload.sessionId,
        hasActions: payload.actions?.length ?? 0,
        hasActionToken: Boolean(payload.actionToken),
        userId,
      }),
    )

    const vapidPublicKey = this.env.VAPID_PUBLIC_KEY
    const vapidPrivateKey = this.env.VAPID_PRIVATE_KEY
    const vapidSubject = this.env.VAPID_SUBJECT
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      console.log(`${tag} VAPID not configured — skipping`)
      return
    }

    // Check user preferences cascade
    try {
      const prefs = await this.env.AUTH_DB.prepare(
        'SELECT key, value FROM user_preferences WHERE user_id = ? AND key LIKE ?',
      )
        .bind(userId, 'push.%')
        .all<{ key: string; value: string }>()

      const prefMap = new Map(prefs.results.map((r) => [r.key, r.value]))

      // Master toggle
      if (prefMap.get('push.enabled') === 'false') {
        console.log(`${tag} push.enabled=false — skipping`)
        return
      }

      // Event-specific toggle
      const prefKey = `push.${eventType}`
      if (prefMap.get(prefKey) === 'false') {
        console.log(`${tag} ${prefKey}=false — skipping`)
        return
      }
    } catch (err) {
      console.error(`${tag} preference lookup failed (continuing as opt-in):`, err)
    }

    // Fetch subscriptions
    let subscriptions: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
    try {
      const result = await this.env.AUTH_DB.prepare(
        'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
      )
        .bind(userId)
        .all<{ id: string; endpoint: string; p256dh: string; auth: string }>()
      subscriptions = result.results
    } catch (err) {
      console.error(`${tag} subscription lookup failed:`, err)
      return
    }

    console.log(`${tag} ${subscriptions.length} subscription(s)`)
    if (subscriptions.length === 0) return

    const vapid = { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject }

    // Send to all subscriptions (best-effort, no retry)
    for (const sub of subscriptions) {
      const endpointSummary = sub.endpoint.slice(0, 60)
      const result = await sendPushNotification(sub, payload, vapid)
      console.log(
        `${tag} send sub=${sub.id} endpoint=${endpointSummary}... ok=${result.ok} status=${result.status ?? 'n/a'} gone=${Boolean(result.gone)}`,
      )
      if (result.gone) {
        // 410 Gone — delete stale subscription
        try {
          await this.env.AUTH_DB.prepare('DELETE FROM push_subscriptions WHERE id = ?')
            .bind(sub.id)
            .run()
          console.log(`${tag} deleted stale subscription ${sub.id}`)
        } catch (err) {
          console.error(`${tag} failed to delete stale subscription ${sub.id}:`, err)
        }
      }
    }

    // FCM fan-out (Capacitor Android shell). Reads `FCM_SERVICE_ACCOUNT_JSON`
    // — a Worker secret containing the Firebase service account JSON. Opt-in:
    // when unset, the FCM path is silently skipped (no Capacitor deployment).
    const fcmServiceAccount = this.env.FCM_SERVICE_ACCOUNT_JSON
    if (fcmServiceAccount) {
      let fcmRows: Array<{ id: string; token: string }> = []
      try {
        const fcmResult = await this.env.AUTH_DB.prepare(
          'SELECT id, token FROM fcm_subscriptions WHERE user_id = ?',
        )
          .bind(userId)
          .all<{ id: string; token: string }>()
        fcmRows = fcmResult.results
      } catch (err) {
        console.error(`${tag} fcm subscription lookup failed:`, err)
      }

      if (fcmRows.length > 0) {
        console.log(`${tag} fcm ${fcmRows.length} subscription(s)`)
        for (const row of fcmRows) {
          try {
            const tokenSummary = row.token.slice(0, 16)
            const result = await sendFcmNotification(row.token, payload, fcmServiceAccount)
            console.log(
              `${tag} fcm send sub=${row.id} token=${tokenSummary}... ok=${result.ok} status=${result.status ?? 'n/a'} gone=${Boolean(result.gone)}`,
            )
            if (result.gone) {
              try {
                await this.env.AUTH_DB.prepare('DELETE FROM fcm_subscriptions WHERE id = ?')
                  .bind(row.id)
                  .run()
                console.log(`${tag} fcm deleted stale subscription ${row.id}`)
              } catch (err) {
                console.error(`${tag} fcm failed to delete stale subscription ${row.id}:`, err)
              }
            }
          } catch (err) {
            console.error(`${tag} fcm send threw for sub=${row.id}:`, err)
          }
        }
      }
    }
  }

  // ── @callable RPC Methods ─────────────────────────────────────

  @callable()
  async spawn(config: SpawnConfig): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    if (this.state.status === 'running' || this.state.status === 'waiting_gate') {
      return { ok: false, error: 'Session already active' }
    }

    const now = new Date().toISOString()
    const id = this.ctx.id.toString()

    const freshState: SessionMeta = {
      ...DEFAULT_META,
      status: 'running',
      session_id: id,
      userId: this.state.userId,
      project: config.project,
      project_path: config.project,
      model: config.model ?? null,
      prompt: typeof config.prompt === 'string' ? config.prompt : JSON.stringify(config.prompt),
      started_at: now,
      created_at: this.state.created_at || now,
      updated_at: now,
    }
    this.setState(freshState)
    this.persistMetaPatch(freshState)

    // Persist initial prompt as a user message so it survives reload
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: contentToParts(config.prompt),
      createdAt: new Date(),
      canonical_turn_id: userMsgId,
    }
    try {
      await this.session.appendMessage(userMsg)
      this.persistTurnState()
      this.broadcastMessage(userMsg)
    } catch (err) {
      console.error(`[SessionDO:${id}] Failed to persist initial prompt:`, err)
    }

    void this.triggerGatewayDial({
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

  /**
   * Resume a discovered VPS session by sdk_session_id.
   * Called from the /create handler when sdk_session_id is present.
   */
  private async resumeDiscovered(
    config: SpawnConfig,
    sdkSessionId: string,
  ): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    if (this.state.status === 'running' || this.state.status === 'waiting_gate') {
      return { ok: false, error: 'Session already active' }
    }

    const now = new Date().toISOString()
    const id = this.ctx.id.toString()

    const resumeState: SessionMeta = {
      ...DEFAULT_META,
      status: 'running',
      session_id: id,
      userId: this.state.userId,
      project: config.project,
      project_path: config.project,
      model: config.model ?? null,
      prompt: typeof config.prompt === 'string' ? config.prompt : JSON.stringify(config.prompt),
      started_at: now,
      created_at: this.state.created_at || now,
      updated_at: now,
      sdk_session_id: sdkSessionId,
    }
    this.setState(resumeState)
    this.persistMetaPatch(resumeState)

    // Persist resume prompt as a user message
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: [
        {
          type: 'text',
          text: typeof config.prompt === 'string' ? config.prompt : JSON.stringify(config.prompt),
        },
      ],
      createdAt: new Date(),
      canonical_turn_id: userMsgId,
    }
    try {
      await this.session.appendMessage(userMsg)
      this.persistTurnState()
      this.broadcastMessage(userMsg)
    } catch (err) {
      console.error(`[SessionDO:${id}] Failed to persist resume prompt:`, err)
    }

    void this.triggerGatewayDial({
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

  @callable()
  async stop(reason?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return { ok: false, error: `Cannot stop: status is '${this.state.status}'` }
    }

    // Transition unilaterally so stop unsticks sessions even when the gateway WS
    // is half-open / dead. The gateway send is best-effort — its ack can't be
    // trusted to arrive, so we don't gate local recovery on it.
    this.updateState({
      status: 'idle',
      gate: null,
      error: null,
      active_callback_token: undefined,
    })
    this.syncStatusToD1(new Date().toISOString())

    const gwConnId = this.getGatewayConnectionId()
    if (gwConnId) {
      this.sendToGateway({ type: 'stop', session_id: this.state.session_id ?? '' })
    }

    console.log(`[SessionDO:${this.ctx.id}] stop: ${reason ?? 'user request'}`)
    return { ok: true }
  }

  @callable()
  async abort(reason?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return { ok: false, error: `Cannot abort: status is '${this.state.status}'` }
    }

    this.updateState({
      status: 'idle',
      gate: null,
      error: null,
      active_callback_token: undefined,
    })
    this.sendToGateway({ type: 'abort', session_id: this.state.session_id ?? '' })
    this.syncStatusToD1(new Date().toISOString())
    console.log(`[SessionDO:${this.ctx.id}] abort: ${reason ?? 'user request'}`)
    return { ok: true }
  }

  /**
   * Force-stop a wedged session. This is the escalation lever exposed to
   * the UI when a previous `interrupt` / `stop` hasn't settled — typically
   * because the dial-back WS is dead (runner still alive on the VPS, but
   * the in-band `abort` command never reaches it).
   *
   * Transition-wise this matches `abort`: we flip status → idle
   * unilaterally and drop the callback token. The delta vs `abort` is the
   * out-of-band HTTP call to `POST /sessions/:id/kill` on the gateway,
   * which SIGTERMs the runner by PID straight from its `.pid` file. Even
   * if the WS command is lost in flight, the process goes away.
   *
   * Returns a classified outcome so the caller can surface failures
   * (timeout / gateway unreachable / pid not found). The DO has already
   * locally recovered regardless — `forceStop` never leaves the DO in a
   * weird state.
   */
  @callable()
  async forceStop(reason?: string): Promise<{
    ok: boolean
    error?: string
    kill:
      | { kind: 'skipped'; reason: 'no_gateway_url' | 'no_session_id' }
      | { kind: 'signalled'; pid: number; sigkill_grace_ms: number }
      | { kind: 'already_terminal'; state: string }
      | { kind: 'not_found' }
      | { kind: 'unreachable'; reason: string }
  }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return {
        ok: false,
        error: `Cannot force-stop: status is '${this.state.status}'`,
        kill: { kind: 'skipped', reason: 'no_session_id' },
      }
    }

    const sessionId = this.state.session_id
    this.updateState({
      status: 'idle',
      gate: null,
      error: null,
      active_callback_token: undefined,
    })

    // Best-effort in-band abort — harmless if the WS is dead.
    if (sessionId) {
      this.sendToGateway({ type: 'abort', session_id: sessionId })
    }
    this.syncStatusToD1(new Date().toISOString())

    // Out-of-band SIGTERM via gateway HTTP. This is the slice that
    // actually rescues the stuck-runner case.
    const gatewayUrl = this.env.CC_GATEWAY_URL
    let killResult:
      | { kind: 'skipped'; reason: 'no_gateway_url' | 'no_session_id' }
      | { kind: 'signalled'; pid: number; sigkill_grace_ms: number }
      | { kind: 'already_terminal'; state: string }
      | { kind: 'not_found' }
      | { kind: 'unreachable'; reason: string }
    if (!gatewayUrl) {
      killResult = { kind: 'skipped', reason: 'no_gateway_url' }
    } else if (!sessionId) {
      killResult = { kind: 'skipped', reason: 'no_session_id' }
    } else {
      killResult = await killSession(gatewayUrl, this.env.CC_GATEWAY_SECRET, sessionId, 5_000)
    }

    console.log(
      `[SessionDO:${this.ctx.id}] forceStop: ${reason ?? 'user request'} kill=${killResult.kind}`,
    )
    return { ok: true, kill: killResult }
  }

  @callable()
  async resolveGate(
    gateId: string,
    response: GateResponse,
  ): Promise<{ ok: boolean; error?: string }> {
    // Relaxed: accept resolveGate in any status. The CLI terminal may have
    // already resolved the tool (advancing status to 'running'), but the web
    // UI still has the GateResolver mounted. Rejecting here just blocks the
    // user with a confusing error. The gate-id lookup below is the real guard
    // — if the part was already resolved, findPendingGatePart returns null and
    // we return a clean "not found" error instead of a status mismatch.

    // Primary path: the scalar state.gate matches. Fallback: the scalar
    // drifted (dropped broadcast, runner reconnect, multiple in-flight
    // gates) but the caller is answering a real pending part. Accept any
    // toolCallId that maps to a history part still in 'approval-requested'.
    // Only clear the scalar state.gate when we resolved against it — if a
    // newer gate is live, leave it so the UI keeps rendering the new
    // question.
    const scalarMatched = !!(this.state.gate && this.state.gate.id === gateId)
    let gate: { id: string; type: 'ask_user' | 'permission_request' } | null = scalarMatched
      ? (this.state.gate as { id: string; type: 'ask_user' | 'permission_request' })
      : null

    if (!gate) {
      const match = findPendingGatePart(this.session.getHistory(), gateId)
      if (match) gate = { id: gateId, type: match.type }
    }

    if (!gate) {
      return {
        ok: false,
        error: `Gate '${gateId}' not found (no pending part); current scalar='${this.state.gate?.id ?? 'none'}'`,
      }
    }

    if (gate.type === 'permission_request' && response.approved !== undefined) {
      this.sendToGateway({
        type: 'permission-response',
        session_id: this.state.session_id ?? '',
        tool_call_id: gateId,
        allowed: response.approved,
      })
    } else if (gate.type === 'ask_user' && response.answer !== undefined) {
      this.sendToGateway({
        type: 'answer',
        session_id: this.state.session_id ?? '',
        tool_call_id: gateId,
        answers: { answer: response.answer },
      })
    } else {
      return { ok: false, error: 'Invalid response for gate type' }
    }

    // Update the message part state for the resolved gate.  Scan all
    // messages (newest-first) for the matching toolCallId rather than
    // guessing the message ID via currentTurnMessageId / turnCounter — the
    // part may live in any message after promoteToolPartToGate.
    const history = this.session.getHistory()
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      const partIdx = msg.parts.findIndex((p) => p.toolCallId === gateId)
      if (partIdx === -1) continue

      const updatedParts = msg.parts.map((p) => {
        if (p.toolCallId !== gateId) return p
        if (response.approved !== undefined) {
          return {
            ...p,
            state: response.approved ? 'output-available' : 'output-denied',
            ...(response.approved && response.answer ? { output: response.answer } : {}),
          }
        }
        if (response.answer !== undefined) {
          return { ...p, state: 'output-available', output: response.answer }
        }
        return p
      })
      const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
      try {
        this.session.updateMessage(updatedMsg)
        this.broadcastMessage(updatedMsg)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to update gate resolution:`, err)
      }
      break
    }

    if (scalarMatched) {
      this.updateState({ status: 'running', gate: null })
    }
    // else: a newer gate is still live in state.gate — leave the scalar
    // alone. The resolved part has already been flipped to
    // output-available/denied above, so the UI will drop its GateResolver
    // for this toolCallId while the live gate remains pending.
    return { ok: true }
  }

  @callable()
  async sendMessage(
    content: string | ContentBlock[],
    opts?: { submitId?: string; client_message_id?: string },
  ): Promise<{ ok: boolean; error?: string; recoverable?: 'forkWithHistory' }> {
    // Idempotency: if a submitId was supplied and we've already accepted it,
    // treat this as a duplicate of that prior call and no-op. Rows older than
    // 60s are pruned on each insert to cap table growth.
    if (opts?.submitId !== undefined) {
      const submitId = opts.submitId
      if (typeof submitId !== 'string' || submitId.length === 0 || submitId.length > 64) {
        return { ok: false, error: 'invalid submitId' }
      }
      const claim = claimSubmitId(this.sql.bind(this), submitId)
      if (!claim.ok) {
        return { ok: false, error: claim.error }
      }
      if (claim.duplicate) {
        return { ok: true }
      }
    }

    const { status } = this.state
    // A session-runner stays alive through `type=result` and blocks waiting on
    // the next stream-input (see claude-runner.ts multi-turn loop). Route by
    // connection liveness, not by DO status: if the gateway-role WS is still
    // attached, reuse that runner — dialling a fresh one would collide with
    // the existing sdk_session_id inside session-runner's hasLiveResume guard
    // and nothing would happen from the user's perspective.
    const hasLiveRunner = Boolean(this.getGatewayConnectionId())
    const isResumable = !hasLiveRunner && status === 'idle' && this.state.sdk_session_id

    if (!hasLiveRunner && !isResumable) {
      return { ok: false, error: `Cannot send message: status is '${status}'` }
    }

    // GH#8 preflight: if we're about to trigger a gateway dial but the
    // gateway-contract env vars are missing, fail loudly BEFORE persisting
    // the user message. Otherwise the message lands in history, the
    // triggerGatewayDial bail at line ~315 flips status to idle, and the
    // user perceives a "silent no-op" with nothing in the transcript to
    // explain it. See planning/research/2026-04-18-verify-infra-issue-8.md.
    if (!hasLiveRunner && isResumable) {
      if (!this.env.CC_GATEWAY_URL || !this.env.WORKER_PUBLIC_URL) {
        console.error(
          `[SessionDO:${this.ctx.id}] sendMessage preflight: CC_GATEWAY_URL=${Boolean(this.env.CC_GATEWAY_URL)} WORKER_PUBLIC_URL=${Boolean(this.env.WORKER_PUBLIC_URL)} — gateway not configured`,
        )
        return {
          ok: false,
          error:
            'Gateway not configured for this worker (missing CC_GATEWAY_URL or WORKER_PUBLIC_URL)',
        }
      }
    }

    // If we're about to take the resume path, preflight for an orphan
    // runner that would hijack the sdk_session_id. If found, auto-fork to a
    // fresh SDK session so the user doesn't see silent failure.
    if (!hasLiveRunner && isResumable) {
      const sdk = this.state.sdk_session_id ?? ''
      const gatewayUrl = this.env.CC_GATEWAY_URL
      if (gatewayUrl && sdk) {
        try {
          const sessions = await listSessions(gatewayUrl, this.env.CC_GATEWAY_SECRET)
          const orphan = sessions.find((s) => s.sdk_session_id === sdk && s.state === 'running')
          if (orphan) {
            console.warn(
              `[SessionDO:${this.ctx.id}] sendMessage: orphan runner ${orphan.session_id} holds sdk_session_id ${sdk} — auto-forking with transcript`,
            )
            return this.forkWithHistory(content)
          }
        } catch (err) {
          // Non-fatal: fall through to the dial attempt. If it then collides
          // the runner will crash and the exit file makes it visible.
          console.warn(`[SessionDO:${this.ctx.id}] sendMessage preflight failed:`, err)
        }
      }
    }

    // Persist user message (only after orphan preflight so we don't have to
    // roll it back on the auto-fork branch — forkWithHistory appends itself).
    this.turnCounter++
    const canonicalTurnId = `usr-${this.turnCounter}`
    const userMsgId = opts?.client_message_id ?? canonicalTurnId
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: contentToParts(content),
      createdAt: new Date(),
      canonical_turn_id: canonicalTurnId,
    }
    try {
      await this.session.appendMessage(userMsg)
      this.persistTurnState()
      // P2 B2: piggyback affected parent's sibling list onto the same delta
      // (instead of separately broadcasting a snapshot).
      const branchInfoRow = this.computeBranchInfoForUserTurn(userMsg)
      this.broadcastMessages({
        kind: 'delta',
        upsert: [userMsg as unknown as WireSessionMessage],
        ...(branchInfoRow ? { branchInfo: { upsert: [branchInfoRow] } } : {}),
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to persist user message:`, err)
    }

    if (hasLiveRunner) {
      // Promote state back to running so the UI reflects the new turn.
      if (status !== 'running' && status !== 'waiting_gate') {
        this.updateState({ status: 'running', gate: null, error: null })
      }
      this.sendToGateway({
        type: 'stream-input',
        session_id: this.state.session_id ?? '',
        message: { role: 'user', content },
        ...(opts?.client_message_id ? { client_message_id: opts.client_message_id } : {}),
      })
    } else if (isResumable) {
      this.updateState({ status: 'running', gate: null, error: null })
      void this.triggerGatewayDial({
        type: 'resume',
        project: this.state.project,
        prompt: content,
        sdk_session_id: this.state.sdk_session_id ?? '',
      })
    }

    return { ok: true }
  }

  /**
   * Spawn a fresh SDK session (new sdk_session_id) seeded with a transcript
   * of the prior conversation. Feels like a resume from the user's POV but
   * sidesteps SDK `resume` entirely — useful when the prior sdk_session_id
   * is orphaned by a stuck session-runner, unresumable, or we just want a
   * clean context window without losing the thread.
   */
  @callable()
  async forkWithHistory(
    content: string | ContentBlock[],
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.state.project) {
      return { ok: false, error: 'Session has no project — cannot fork.' }
    }

    // Build a compact transcript from local history (safe to read even when
    // the DO has lost WS contact with its session-runner).
    const history = this.session.getHistory()
    const transcript = history
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
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: userMsgId,
      role: 'user',
      parts: contentToParts(content),
      createdAt: new Date(),
      canonical_turn_id: userMsgId,
    }
    try {
      await this.session.appendMessage(userMsg)
      this.persistTurnState()
      // P2 B2: piggyback affected parent's sibling list onto the same delta.
      const branchInfoRow = this.computeBranchInfoForUserTurn(userMsg)
      this.broadcastMessages({
        kind: 'delta',
        upsert: [userMsg as unknown as WireSessionMessage],
        ...(branchInfoRow ? { branchInfo: { upsert: [branchInfoRow] } } : {}),
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] forkWithHistory: persist user msg failed:`, err)
    }

    // Drop the old sdk_session_id so the new runner gets a brand-new one
    // (guarantees no hasLiveResume collision with any orphan).
    this.updateState({
      status: 'running',
      gate: null,
      error: null,
      sdk_session_id: null,
    })

    void this.triggerGatewayDial({
      type: 'execute',
      project: this.state.project,
      prompt: forkedPrompt,
    })

    return { ok: true }
  }

  @callable()
  async interrupt(): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return { ok: false, error: `Cannot interrupt: status is '${this.state.status}'` }
    }

    // Release ALL pending gate parts, not just the one tracked in
    // state.gate. The scalar and history can drift (dropped broadcast,
    // multiple gates in flight), so the UI may be rendering a
    // GateResolver for a tool_call_id that state.gate never tracked.
    // Flipping every approval-requested gate part to 'output-denied'
    // guarantees the UI clears its GateResolver(s) when the user hits
    // interrupt. The subsequent `interrupt` command to the runner aborts
    // the SDK's in-flight canUseTool promise — no per-gate cancel
    // command exists, so we rely on the SDK interrupt to release the
    // pending answer/permission wait.
    const history = this.session.getHistory()
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      const hasPendingGate = msg.parts.some(
        (p) =>
          p.state === 'approval-requested' &&
          (p.type === 'tool-ask_user' || p.type === 'tool-permission'),
      )
      if (!hasPendingGate) continue
      const updatedParts = msg.parts.map((p) =>
        p.state === 'approval-requested' &&
        (p.type === 'tool-ask_user' || p.type === 'tool-permission')
          ? { ...p, state: 'output-denied' as const, output: 'Interrupted' }
          : p,
      )
      const updatedMsg: SessionMessage = { ...msg, parts: updatedParts }
      try {
        this.session.updateMessage(updatedMsg)
        this.broadcastMessage(updatedMsg)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to mark gate interrupted:`, err)
      }
    }

    // Always clear the scalar gate + flip status back to running so the
    // watchdog and UI agree the session has left waiting_gate.
    if (this.state.gate || this.state.status === 'waiting_gate') {
      this.updateState({ status: 'running', gate: null })
    }

    this.sendToGateway({ type: 'interrupt', session_id: this.state.session_id ?? '' })
    return { ok: true }
  }

  /**
   * P3 B4: cached-or-fresh context usage reader.
   *
   * Semantics:
   * - Fresh cache hit (<5s old) → return cached value, `isCached: true`.
   * - Stale-or-missing + gateway connected → single-flight probe with 3s
   *   timeout; on success UPDATE the cache and return `isCached: false`.
   * - No gateway connection → return stale cache (or null) with
   *   `isCached: true`.
   * - Probe timeout or error → fall through to stale cache / null.
   *
   * Retained as `@callable()` so the existing client-side
   * `connection.call('getContextUsage', [])` trigger continues to work.
   * Also invoked via HTTP by `onRequest`'s `GET /context-usage` route
   * (backing `/api/sessions/:id/context-usage`).
   */
  @callable()
  async getContextUsage(): Promise<{
    contextUsage: ContextUsage | null
    fetchedAt: string
    isCached: boolean
  }> {
    const rows = this.sql<{
      context_usage_json: string | null
      context_usage_cached_at: number | null
    }>`SELECT context_usage_json, context_usage_cached_at FROM session_meta WHERE id = 1`
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
    if (!this.getGatewayConnectionId()) {
      return {
        contextUsage: cached?.value ?? null,
        fetchedAt: cached ? new Date(cached.cachedAt).toISOString() : new Date().toISOString(),
        isCached: true,
      }
    }
    if (!this.contextUsageProbeInFlight) {
      this.contextUsageProbeInFlight = this.probeContextUsageWithTimeout().finally(() => {
        this.contextUsageProbeInFlight = null
      })
    }
    try {
      const value = await this.contextUsageProbeInFlight
      const cachedAt = Date.now()
      this.sql`UPDATE session_meta
        SET context_usage_json = ${JSON.stringify(value)},
            context_usage_cached_at = ${cachedAt},
            updated_at = ${cachedAt}
        WHERE id = 1`
      return {
        contextUsage: value,
        fetchedAt: new Date(cachedAt).toISOString(),
        isCached: false,
      }
    } catch {
      return {
        contextUsage: cached?.value ?? null,
        fetchedAt: cached ? new Date(cached.cachedAt).toISOString() : new Date().toISOString(),
        isCached: true,
      }
    }
  }

  /**
   * P3 B4: dispatch a `get-context-usage` GatewayCommand and await the
   * matched `context_usage` gateway_event. 3s timeout — if the runner is
   * unresponsive we reject and the caller falls back to stale / null rather
   * than blocking the Worker up to its CPU limit.
   */
  private probeContextUsageWithTimeout(): Promise<ContextUsage | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this resolver so a late gateway reply doesn't leak into
        // the next probe's resolver slot.
        const idx = this.contextUsageResolvers.findIndex((r) => r.resolve === innerResolve)
        if (idx >= 0) this.contextUsageResolvers.splice(idx, 1)
        reject(new Error('probe_timeout'))
      }, 3_000)
      const innerResolve = (v: ContextUsage | null) => {
        clearTimeout(timer)
        resolve(v)
      }
      const innerReject = (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      }
      this.contextUsageResolvers.push({ resolve: innerResolve, reject: innerReject })
      this.sendToGateway({ type: 'get-context-usage', session_id: this.state.session_id ?? '' })
    })
  }

  /**
   * P3 B5: kataState reader backed by the D1 `agent_sessions` mirror (source
   * of truth — written by `syncKataToD1` on every `kata_state` event). Also
   * consults the DO-local `kv.kata_state` blob for the richer full shape;
   * falls back to a minimal shape synthesized from the D1 columns if the kv
   * blob is absent (e.g. after cold-start before the first kata_state event).
   *
   * Returns `null` when the session has no kata binding. The route returns a
   * value even when the runner is dead because the D1 mirror survives.
   */
  async getKataState(): Promise<{ kataState: KataSessionState | null; fetchedAt: string }> {
    const sessionId = this.state.session_id ?? this.ctx.id.toString()
    try {
      const rows = await this.d1
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
      const kvRows = this.sql<{ value: string }>`SELECT value FROM kv WHERE key = 'kata_state'`
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
      console.error(`[SessionDO:${this.ctx.id}] getKataState failed:`, err)
      return { kataState: null, fetchedAt: new Date().toISOString() }
    }
  }

  @callable()
  async rewind(messageId: string): Promise<{ ok: boolean; error?: string }> {
    this.sendToGateway({
      type: 'rewind',
      session_id: this.state.session_id ?? '',
      message_id: messageId,
    })
    // DO-authored snapshot (B2): broadcast the trimmed history so all clients
    // converge on the post-rewind view without round-tripping through gateway.
    try {
      const history = this.session.getHistory()
      const idx = history.findIndex((m) => m.id === messageId)
      const trimmed = idx >= 0 ? history.slice(0, idx + 1) : history
      this.broadcastMessages({
        kind: 'snapshot',
        version: this.messageSeq,
        messages: trimmed as unknown as WireSessionMessage[],
        reason: 'rewind',
        // B7: rewind may change sibling lists if it removes branches.
        // Compute fresh rows for the trimmed view; client upserts override
        // stale rows (the remove-on-empty case isn't supported, but rewind
        // typically trims rather than deletes branches).
        branchInfo: this.computeBranchInfo(trimmed),
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to broadcast rewind snapshot:`, err)
    }
    return { ok: true }
  }

  @callable()
  async getMessages(opts?: {
    offset?: number
    limit?: number
    session_hint?: string
    leafId?: string
  }) {
    // Self-initialize from D1 for discovered sessions (#7 p6). The cron in
    // src/api/scheduled.ts UPSERTs gateway-discovered rows into agent_sessions
    // every 5 minutes; this just rehydrates a cold DO from that row when the
    // browser hits a session whose DO has no in-memory state yet.
    if (!this.state.sdk_session_id && opts?.session_hint) {
      try {
        const rows = await this.d1
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.id, opts.session_hint))
          .limit(1)
        const row = rows[0]
        if (row?.sdkSessionId) {
          this.updateState({
            sdk_session_id: row.sdkSessionId,
            project: row.project ?? '',
            session_id: row.id,
            summary: row.summary ?? null,
            started_at: row.createdAt || this.state.created_at || new Date().toISOString(),
            created_at: row.createdAt || this.state.created_at || new Date().toISOString(),
          })
        }
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to init from D1:`, err)
      }
    }

    // Hydrate from VPS gateway — syncs any messages we don't have yet.
    // Safe to call when messages already exist (skips already-persisted ones).
    if (this.state.sdk_session_id && this.state.project) {
      await this.hydrateFromGateway()
    }

    // Return messages from Session history
    try {
      return this.session.getHistory(opts?.leafId)
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to get history:`, err)
      return []
    }
  }

  @callable()
  async resubmitMessage(
    originalMessageId: string,
    newContent: string,
  ): Promise<{ ok: boolean; leafId?: string; error?: string }> {
    // 1. If streaming in progress, abort first
    if (this.currentTurnMessageId) {
      this.sendToGateway({ type: 'abort', session_id: this.state.session_id ?? '' })
      // Finalize orphaned streaming parts
      const existing = this.session.getMessage(this.currentTurnMessageId)
      if (existing) {
        const finalizedParts = finalizeStreamingParts(existing.parts)
        this.session.updateMessage({ ...existing, parts: finalizedParts })
      }
      this.currentTurnMessageId = null
    }

    // 2. Find the parent of the original message
    const originalMsg = this.session.getMessage(originalMessageId)
    if (!originalMsg) {
      return { ok: false, error: 'Original message not found' }
    }

    // Get history to find parent: the message before originalMessageId in the path
    const history = this.session.getHistory(originalMessageId)
    const origIdx = history.findIndex((m) => m.id === originalMessageId)
    const parentId = origIdx > 0 ? history[origIdx - 1].id : null

    // 3. Create new user message as sibling branch
    this.turnCounter++
    const newUserMsgId = `usr-${this.turnCounter}`
    const newUserMsg: SessionMessage & { canonical_turn_id?: string } = {
      id: newUserMsgId,
      role: 'user',
      parts: [{ type: 'text', text: newContent }],
      createdAt: new Date(),
      canonical_turn_id: newUserMsgId,
    }

    try {
      this.session.appendMessage(newUserMsg, parentId)
      this.persistTurnState()
      this.broadcastMessage(newUserMsg)
      // DO-authored snapshot (B2): broadcast the branch view so all clients
      // realign onto the new leaf. getHistory(leafId) returns the path ending
      // at newUserMsg.id.
      const resubmitHistory = this.session.getHistory(newUserMsg.id)
      this.broadcastMessages({
        kind: 'snapshot',
        version: this.messageSeq,
        messages: resubmitHistory as unknown as WireSessionMessage[],
        reason: 'resubmit',
        // B7: the affected parent now has a new sibling — compute fresh
        // branchInfo for the resubmitted branch's history.
        branchInfo: this.computeBranchInfo(resubmitHistory),
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to create branch:`, err)
      return { ok: false, error: 'Failed to create branch' }
    }

    // 4. Send to gateway for execution
    this.updateState({ status: 'running', gate: null, error: null })
    void this.triggerGatewayDial({
      type: 'resume',
      project: this.state.project,
      prompt: newContent,
      sdk_session_id: this.state.sdk_session_id ?? '',
    })

    return { ok: true, leafId: newUserMsgId }
  }

  @callable()
  async getBranchHistory(
    leafId: string,
  ): Promise<{ ok: true } | { ok: false; error: 'unknown_leaf' | 'not_on_branch' }> {
    const history = this.session.getHistory()
    const found = history.find((m) => m.id === leafId)
    if (!found) return { ok: false, error: 'unknown_leaf' }
    if (found.role !== 'user') return { ok: false, error: 'not_on_branch' }
    // Known limitation: scope branch-navigate snapshot to the requesting
    // client once `@callable` surfaces the caller connection id. The agents
    // SDK (v0.11) dispatches RPCs via `super.onMessage` with no public
    // callback for caller identity, so we broadcast to all browser
    // connections. Harmless over-delivery — matches B1 correctness and the
    // client's per-session `lastSeq` watermark still drops stale frames.
    const messages = this.session.getHistory(leafId) ?? history
    this.broadcastMessages({
      kind: 'snapshot',
      version: this.messageSeq,
      messages: messages as unknown as WireSessionMessage[],
      reason: 'branch-navigate',
      // B7: target branch's sibling map so the recipient's UI updates in
      // lockstep with the history swap.
      branchInfo: this.computeBranchInfo(messages),
    })
    return { ok: true }
  }

  @callable()
  async requestSnapshot(): Promise<{ ok: true } | { ok: false; error: 'session_empty' }> {
    const messages = this.session.getHistory()
    if (messages.length === 0) return { ok: false, error: 'session_empty' }
    // Known limitation: scope reconnect snapshot to the requesting client
    // once `@callable` surfaces the caller connection id. Broadcast to all
    // clients for now — harmless over-delivery in multi-client sessions
    // (the client's per-session `lastSeq` watermark drops stale frames).
    this.broadcastMessages({
      kind: 'snapshot',
      version: this.messageSeq,
      messages: messages as unknown as WireSessionMessage[],
      reason: 'reconnect',
      // B7: hydrate branch-info collection alongside the history.
      branchInfo: this.computeBranchInfo(messages),
    })
    return { ok: true }
  }

  @callable()
  async getStatus() {
    return {
      state: this.state,
      recent_events: [],
    }
  }

  @callable()
  async getKataStatus() {
    const rows = this.sql<{ value: string }>`SELECT value FROM kv WHERE key = 'kata_state'`
    const arr = [...rows]
    if (arr.length === 0) return null
    try {
      return JSON.parse(arr[0].value)
    } catch {
      return null
    }
  }

  // ── Gateway Event Handling ─────────────────────────────────────

  handleGatewayEvent(event: GatewayEvent) {
    switch (event.type) {
      case 'session.init':
        this.updateState({ sdk_session_id: event.sdk_session_id, model: event.model })
        // Sync sdk_session_id to D1 so discovery won't create a duplicate row.
        if (event.sdk_session_id) {
          this.syncSdkSessionIdToD1(event.sdk_session_id, new Date().toISOString())
        }
        break

      case 'partial_assistant': {
        const parts = partialAssistantToParts(event.content)
        const msgId = `msg-${this.turnCounter}`

        if (!this.currentTurnMessageId) {
          this.currentTurnMessageId = msgId

          // Check if message already exists (multi-response turn: assistant → tool → assistant)
          const existing = this.session.getMessage(msgId)
          if (existing) {
            // Merge streaming text / reasoning into existing parts (preserving tool results)
            const updatedParts = [...existing.parts]
            for (const newPart of parts) {
              if (newPart.type === 'text' || newPart.type === 'reasoning') {
                updatedParts.push(newPart)
              }
            }
            const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
            try {
              this.session.updateMessage(updatedMsg)
              this.broadcastMessage(updatedMsg)
            } catch (err) {
              console.error(`[SessionDO:${this.ctx.id}] Failed to update partial assistant:`, err)
              this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
            }
          } else {
            // First partial of this turn — append new message. Parent defaults
            // to latestLeafRow() (the user row just persisted in sendMessage),
            // whose id may be `usr-N` OR `usr-client-<uuid>` depending on
            // whether the client supplied a `client_message_id` (GH#14 B6).
            // Passing an explicit `usr-${turnCounter}` used to silently land
            // parent_id=NULL when the user row was keyed on the client id —
            // orphaning every assistant and collapsing getHistory() to one row.
            const msg: SessionMessage = {
              id: msgId,
              role: 'assistant',
              parts,
              createdAt: new Date(),
            }
            try {
              this.session.appendMessage(msg)
              this.persistTurnState()
              this.broadcastMessage(msg)
            } catch (err) {
              console.error(`[SessionDO:${this.ctx.id}] Failed to persist partial assistant:`, err)
              this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
            }
          }
        } else {
          // Subsequent partial — update existing message with accumulated text
          const existing = this.session.getMessage(this.currentTurnMessageId)
          if (existing) {
            // Merge streaming parts: find an existing streaming text / reasoning
            // part of the same kind and append the delta. This drives live
            // token-by-token rendering for both the assistant text and the
            // extended-thinking trace.
            const updatedParts = [...existing.parts]
            for (const newPart of parts) {
              if (newPart.type === 'text') {
                const existingIdx = updatedParts.findIndex(
                  (p) => p.type === 'text' && p.state === 'streaming',
                )
                if (existingIdx !== -1) {
                  updatedParts[existingIdx] = {
                    ...updatedParts[existingIdx],
                    text: (updatedParts[existingIdx].text ?? '') + (newPart.text ?? ''),
                  }
                } else {
                  updatedParts.push(newPart)
                }
              } else if (newPart.type === 'reasoning') {
                const existingIdx = updatedParts.findIndex(
                  (p) => p.type === 'reasoning' && p.state === 'streaming',
                )
                if (existingIdx !== -1) {
                  updatedParts[existingIdx] = {
                    ...updatedParts[existingIdx],
                    text: (updatedParts[existingIdx].text ?? '') + (newPart.text ?? ''),
                  }
                } else {
                  updatedParts.push(newPart)
                }
              }
            }
            const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
            try {
              this.session.updateMessage(updatedMsg)
              this.broadcastMessage(updatedMsg)
            } catch (err) {
              console.error(`[SessionDO:${this.ctx.id}] Failed to update partial:`, err)
              this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
            }
          }
        }
        break
      }

      case 'assistant': {
        // Final assistant message — finalize streaming parts with final content
        const newParts = assistantContentToParts(event.content as unknown[])
        const msgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`

        // Merge finalizes any streaming text/reasoning parts (preserving the
        // text accumulated from partial_assistant deltas) and appends newParts
        // while avoiding duplicating text/reasoning that already streamed — the
        // SDK's final assistant event may or may not re-emit thinking blocks,
        // so the authoritative copy of extended-thinking traces is the streamed
        // one. See mergeFinalAssistantParts + its regression-guard tests.
        const existing = this.session.getMessage(msgId)
        const mergedParts = mergeFinalAssistantParts(existing?.parts, newParts)

        const msg: SessionMessage = {
          id: msgId,
          role: 'assistant',
          parts: mergedParts,
          createdAt: existing?.createdAt ?? new Date(),
        }
        try {
          if (existing) {
            this.session.updateMessage(msg)
          } else {
            // No partial fired first — append from scratch. Parent defaults to
            // latestLeafRow(), which is the user row this assistant replies
            // to. See partial_assistant branch for the full rationale.
            this.session.appendMessage(msg)
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
          this.broadcastMessage(msg)
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to persist assistant:`, err)
          this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
        }
        this.updateState({ num_turns: this.state.num_turns + 1 })
        this.broadcastSessionSummary()
        break
      }

      case 'tool_result': {
        // Update the current assistant message's tool parts with results
        const currentMsgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`
        const existing = this.session.getMessage(currentMsgId)
        if (existing) {
          const updatedParts = applyToolResult(existing.parts, event)
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            this.session.updateMessage(updatedMsg)
            this.broadcastMessage(updatedMsg)
          } catch (err) {
            console.error(`[SessionDO:${this.ctx.id}] Failed to persist tool result:`, err)
            this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
          }
        }
        break
      }

      case 'ask_user': {
        // Promote the existing tool-AskUserQuestion part (created by the
        // `assistant` event's tool_use block) to a gate part.  The assistant
        // event already persisted the part with the full input (including
        // the questions array) and the correct toolCallId — we just flip its
        // type + state so the UI renders a GateResolver instead of a pill.
        //
        // This avoids the old design's race: previously we appended a
        // *second* part looked up via currentTurnMessageId which could miss
        // if turnCounter drifted between the assistant and ask_user events.
        this.promoteToolPartToGate(event.tool_call_id, 'tool-ask_user', 'ask_user', {
          questions: event.questions,
        })

        // PRESERVE existing side effects exactly
        this.updateState({
          status: 'waiting_gate',
          gate: {
            id: event.tool_call_id,
            type: 'ask_user',
            detail: { questions: event.questions },
          },
        })
        this.syncStatusToD1(new Date().toISOString())
        this.dispatchPush(
          {
            title: this.state.project || 'Duraclaw',
            body: `Asking: ${((event.questions?.[0] as Record<string, unknown>)?.question as string)?.slice(0, 100) || 'Question'}`,
            url: `/?session=${this.state.session_id}`,
            tag: `session-${this.state.session_id}`,
            sessionId: this.state.session_id ?? '',
            actions: [{ action: 'open', title: 'Open' }],
          },
          'blocked',
        )
        break
      }

      case 'permission_request': {
        // Same strategy as ask_user: promote the existing tool part created
        // by the assistant event rather than appending a duplicate.
        this.promoteToolPartToGate(event.tool_call_id, 'tool-permission', 'permission', {
          tool_name: event.tool_name,
          tool_call_id: event.tool_call_id,
        })

        // PRESERVE all existing side effects (state update, D1 sync, action token, push)
        this.updateState({
          status: 'waiting_gate',
          gate: {
            id: event.tool_call_id,
            type: 'permission_request',
            detail: { tool_name: event.tool_name, input: event.input },
          },
        })
        this.syncStatusToD1(new Date().toISOString())
        ;(async () => {
          try {
            const actionToken = await generateActionToken(
              this.state.session_id ?? '',
              event.tool_call_id,
              this.env.BETTER_AUTH_SECRET,
            )
            this.dispatchPush(
              {
                title: this.state.project || 'Duraclaw',
                body: `Needs permission: ${event.tool_name}`,
                url: `/?session=${this.state.session_id}`,
                tag: `session-${this.state.session_id}`,
                sessionId: this.state.session_id ?? '',
                actionToken,
                actions: [
                  { action: 'approve', title: 'Allow' },
                  { action: 'deny', title: 'Deny' },
                ],
              },
              'blocked',
            )
          } catch (err) {
            console.error(`[SessionDO:${this.ctx.id}] Failed to generate action token:`, err)
          }
        })()
        break
      }

      case 'file_changed': {
        // Add file_changed data part to current assistant message
        const currentMsgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`
        const existing = this.session.getMessage(currentMsgId)
        if (existing) {
          const updatedParts: SessionMessagePart[] = [
            ...existing.parts,
            {
              type: 'data-file-changed',
              text: event.path,
              state: event.tool === 'write' ? 'created' : 'modified',
            },
          ]
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            this.session.updateMessage(updatedMsg)
            this.broadcastMessage(updatedMsg)
          } catch (err) {
            console.error(`[SessionDO:${this.ctx.id}] Failed to persist file_changed:`, err)
          }
        }
        break
      }

      case 'result': {
        // Finalize orphaned streaming parts
        if (this.currentTurnMessageId) {
          const existing = this.session.getMessage(this.currentTurnMessageId)
          if (existing) {
            const finalizedParts = finalizeStreamingParts(existing.parts)
            this.session.updateMessage({ ...existing, parts: finalizedParts })
            this.broadcastMessage({ ...existing, parts: finalizedParts })
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
        }

        // If SDK reported an error result, show it inline as a system message
        if (event.is_error && event.result) {
          this.turnCounter++
          const errorMsgId = `err-${this.turnCounter}`
          const errorMsg: SessionMessage = {
            id: errorMsgId,
            role: 'system',
            parts: [{ type: 'text', text: `⚠ Error: ${event.result}` }],
            createdAt: new Date(),
          }
          this.session.appendMessage(errorMsg)
          this.broadcastMessage(errorMsg)
        }

        // If the SDK result contains text that isn't already in the last message,
        // append it as a visible assistant message so the final response is shown.
        if (!event.is_error && event.result && typeof event.result === 'string') {
          const lastMsgId = `msg-${this.turnCounter}`
          const lastMsg = this.session.getMessage(lastMsgId)
          const lastHasText = lastMsg?.parts?.some(
            (p) => p.type === 'text' && p.state === 'done' && p.text,
          )
          if (!lastHasText) {
            // The last assistant turn had only tool calls, no final text — add result text
            if (lastMsg) {
              const updatedParts: SessionMessagePart[] = [
                ...lastMsg.parts,
                { type: 'text', text: event.result, state: 'done' },
              ]
              const updatedMsg: SessionMessage = { ...lastMsg, parts: updatedParts }
              this.session.updateMessage(updatedMsg)
              this.broadcastMessage(updatedMsg)
            } else {
              this.turnCounter++
              const resultMsgId = `msg-${this.turnCounter}`
              const resultMsg: SessionMessage = {
                id: resultMsgId,
                role: 'assistant',
                parts: [{ type: 'text', text: event.result, state: 'done' }],
                createdAt: new Date(),
              }
              this.session.appendMessage(resultMsg)
              this.broadcastMessage(resultMsg)
            }
          }
        }

        // PRESERVE all existing side effects — always transition to idle.
        // NOTE: `type=result` is a *turn-complete* signal from the SDK, not a
        // session-complete signal. The session-runner stays alive waiting on
        // stream-input for the next turn (see claude-runner multi-turn loop),
        // so we keep active_callback_token intact — clearing it would block the
        // runner from re-dialling if its WS flaps. The token is cleared only
        // on true terminal transitions (stopped/failed/aborted/crashed).
        this.updateState({
          status: 'idle',
          completed_at: new Date().toISOString(),
          result: event.result,
          duration_ms: (this.state.duration_ms ?? 0) + (event.duration_ms ?? 0),
          total_cost_usd: (this.state.total_cost_usd ?? 0) + (event.total_cost_usd ?? 0),
          num_turns: this.state.num_turns + (event.num_turns ?? 0),
          error: event.is_error ? event.result : null,
          summary: event.sdk_summary ?? this.state.summary,
          gate: null,
        })
        {
          const _now = new Date().toISOString()
          this.syncStatusToD1(_now)
          this.syncResultToD1(_now)
        }
        // Push the final aggregated counters so clients update immediately
        // at turn-complete without waiting for the next REST backfill. See
        // `broadcastSessionSummary` preamble for the full rationale.
        this.broadcastSessionSummary()
        // Discovered-session fan-out is now owned by the cron in
        // src/api/scheduled.ts (#7 p6); SessionDO no longer mirrors here.
        if (!event.is_error) {
          this.dispatchPush(
            {
              title: this.state.project || 'Duraclaw',
              body: `Completed (${this.state.num_turns} turns, $${(this.state.total_cost_usd ?? 0).toFixed(2)})`,
              url: `/?session=${this.state.session_id}`,
              tag: `session-${this.state.session_id}`,
              sessionId: this.state.session_id ?? '',
              actions: [
                { action: 'open', title: 'Open' },
                { action: 'new-session', title: 'New Session' },
              ],
            },
            'completed',
          )
        } else {
          this.dispatchPush(
            {
              title: this.state.project || 'Duraclaw',
              body: `Failed: ${event.result || 'Session failed'}`,
              url: `/?session=${this.state.session_id}`,
              tag: `session-${this.state.session_id}`,
              sessionId: this.state.session_id ?? '',
            },
            'error',
          )
        }
        break
      }

      case 'stopped': {
        // Finalize orphaned streaming parts
        if (this.currentTurnMessageId) {
          const existing = this.session.getMessage(this.currentTurnMessageId)
          if (existing) {
            const finalizedParts = finalizeStreamingParts(existing.parts)
            this.session.updateMessage({ ...existing, parts: finalizedParts })
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
        }

        // PRESERVE existing side effects; clear active_callback_token (terminal).
        this.updateState({
          status: 'idle',
          gate: null,
          completed_at: new Date().toISOString(),
          active_callback_token: undefined,
        })
        this.syncStatusToD1(new Date().toISOString())
        break
      }

      case 'kata_state': {
        // PRESERVE existing side effects — store in kv and sync to D1.
        try {
          this
            .sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('kata_state', ${JSON.stringify(event.kata_state)})`
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to persist kata state:`, err)
        }
        this.syncKataToD1(event.kata_state, new Date().toISOString())

        // Chain UX P4: detect mode transitions on chain-linked sessions and
        // reset the runner so each mode gets a fresh SDK session context.
        const ks = event.kata_state
        if (ks?.currentMode && ks.issueNumber != null) {
          const prev = this.state.lastKataMode
          const next = ks.currentMode
          if (prev !== next) {
            this.updateState({ lastKataMode: next })
            // Initial mode observation on a fresh session is NOT a transition —
            // only rotate the runner when we've seen a prior mode. Firing
            // handleModeTransition on the first kata_state would kill the
            // runner that just spawned with the user's typed prompt and
            // replace it with the mode-preamble text.
            if (prev == null) {
              console.log(
                `[SessionDO:${this.ctx.id}] initial mode observed: ${next} — no runner reset`,
              )
            } else if (ks.continueSdk === true) {
              console.log(
                `[SessionDO:${this.ctx.id}] mode change ${prev}→${next} with continueSdk=true, skipping reset`,
              )
            } else {
              // Fire-and-forget — the runner close + respawn involves multi-
              // second awaits that shouldn't block gateway event processing.
              this.handleModeTransition(ks, prev).catch((err) => {
                console.error(`[SessionDO:${this.ctx.id}] handleModeTransition failed:`, err)
              })
            }
          }
        }
        break
      }

      case 'error': {
        // Finalize orphaned streaming parts
        if (this.currentTurnMessageId) {
          const existing = this.session.getMessage(this.currentTurnMessageId)
          if (existing) {
            const finalizedParts = finalizeStreamingParts(existing.parts)
            this.session.updateMessage({ ...existing, parts: finalizedParts })
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
        }

        // Persist error as a visible system message so user sees what happened
        this.turnCounter++
        const errorMsgId = `err-${this.turnCounter}`
        const errorMsg: SessionMessage = {
          id: errorMsgId,
          role: 'system',
          parts: [{ type: 'text', text: `⚠ Error: ${event.error}` }],
          createdAt: new Date(),
        }
        this.session.appendMessage(errorMsg)
        this.broadcastMessage(errorMsg)

        // Transition to 'error' (spec #37 B4) — session surfaces the failure; user
        // can still resubmit to recover. Clears active_callback_token so the
        // current runner is terminal.
        this.updateState({
          status: 'error',
          error: event.error,
          active_callback_token: undefined,
        })
        this.syncStatusToD1(new Date().toISOString())
        this.dispatchPush(
          {
            title: this.state.project || 'Duraclaw',
            body: `Error: ${event.error}`,
            url: `/?session=${this.state.session_id}`,
            tag: `session-${this.state.session_id}`,
            sessionId: this.state.session_id ?? '',
          },
          'error',
        )
        break
      }

      // Heartbeat from gateway — just keeps the connection alive, no broadcast needed
      case 'heartbeat':
        break

      // P3 B4: parse `context_usage` to `ContextUsage`, drain probe resolvers,
      // and update `session_meta.context_usage_json` + cached_at. The original
      // gateway_event broadcast is retained (per P3 brief Non-Goals: keep
      // existing client handlers live until the deferred consumer-migration
      // issue swaps them to REST).
      case 'context_usage': {
        const rawUsage = event.usage ?? {}
        const parsed: ContextUsage = {
          totalTokens: (rawUsage.totalTokens as number) ?? 0,
          maxTokens: (rawUsage.maxTokens as number) ?? 0,
          percentage: (rawUsage.percentage as number) ?? 0,
          model: rawUsage.model as string | undefined,
          isAutoCompactEnabled: rawUsage.isAutoCompactEnabled as boolean | undefined,
          autoCompactThreshold: rawUsage.autoCompactThreshold as number | undefined,
        }
        // Drain any awaiters first so they settle on the fresh value rather
        // than the pre-write cache.
        const resolvers = this.contextUsageResolvers.splice(0)
        for (const r of resolvers) {
          try {
            r.resolve(parsed)
          } catch {
            // Defensive: never let a resolver throw tank the event loop.
          }
        }
        // Persist into the typed session_meta cache so subsequent calls
        // within the 5s TTL hit the fresh row without re-probing.
        try {
          const cachedAt = Date.now()
          this.sql`UPDATE session_meta
            SET context_usage_json = ${JSON.stringify(parsed)},
                context_usage_cached_at = ${cachedAt},
                updated_at = ${cachedAt}
            WHERE id = 1`
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to persist context_usage cache:`, err)
        }
        // Retained WS broadcast — consumer migration is a separate issue.
        this.broadcastGatewayEvent(event)
        break
      }

      // Events that don't produce message parts — just broadcast raw
      default: {
        // rewind_result, session_state_changed, rate_limit,
        // task_started, task_progress, task_notification — broadcast as-is
        this.broadcastGatewayEvent(event)
        break
      }
    }
  }
}
