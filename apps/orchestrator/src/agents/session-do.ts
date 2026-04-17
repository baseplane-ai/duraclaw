import { Agent, type Connection, type ConnectionContext, callable } from 'agents'
import type { SessionMessage, SessionMessagePart } from 'agents/experimental/memory/session'
import { Session } from 'agents/experimental/memory/session'
import { generateActionToken } from '~/lib/action-token'
import { runMigrations } from '~/lib/do-migrations'
import { contentToParts } from '~/lib/message-parts'
import { type PushPayload, sendPushNotification } from '~/lib/push'
import type {
  ContentBlock,
  Env,
  GateResponse,
  GatewayCommand,
  GatewayEvent,
  KataSessionState,
  SessionState,
  SpawnConfig,
} from '~/lib/types'
import { parseEvent } from '~/lib/vps-client'
import {
  applyToolResult,
  assistantContentToParts,
  finalizeStreamingParts,
  partialAssistantToParts,
} from './gateway-event-mapper'
import {
  buildGatewayCallbackUrl,
  buildGatewayStartUrl,
  getGatewayConnectionId,
  loadTurnState,
  validateGatewayToken,
} from './session-do-helpers'
import { SESSION_DO_MIGRATIONS } from './session-do-migrations'

const DEFAULT_STATE: SessionState = {
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

/** If no gateway event arrives within this window, consider the connection dead (ms). */
const STALE_THRESHOLD_MS = 5 * 60_000

export class SessionDO extends Agent<Env, SessionState> {
  initialState = DEFAULT_STATE
  private session!: Session
  private turnCounter = 0
  private currentTurnMessageId: string | null = null
  /** Cached gateway connection ID — avoids SQLite reads on every message. */
  private cachedGatewayConnId: string | null = null
  /** Timestamp of the last gateway event received on the WS connection. */
  private lastGatewayActivity = 0

  // ── Lifecycle ──────────────────────────────────────────────────

  async onStart() {
    runMigrations(this.ctx.storage.sql, SESSION_DO_MIGRATIONS)
    this.session = Session.create(this)

    // Trigger Session's lazy table initialization (creates assistant_config etc.)
    // before we query those tables directly via this.sql.
    const pathLength = this.session.getPathLength()

    // Load persisted turn state from assistant_config
    const turnState = loadTurnState(this.sql.bind(this), pathLength)
    this.turnCounter = turnState.turnCounter
    this.currentTurnMessageId = turnState.currentTurnMessageId

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

    // Delegate to Agent base class for WS upgrades and other routes
    return super.onRequest(request)
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url)
    const role = url.searchParams.get('role')

    if (role === 'gateway') {
      // Gateway connection: validate token
      const token = ctx.request.headers.get('x-gateway-token')
      if (!this.validateGatewayToken(token)) {
        connection.close(4001, 'Invalid or expired gateway token')
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

    // Browser connection: replay full message history
    try {
      const messages = this.session.getHistory()
      if (messages.length > 0) {
        connection.send(JSON.stringify({ type: 'messages', messages }))
      }
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to replay history:`, err)
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

  /** Validate a gateway token against stored token and TTL. */
  private validateGatewayToken(token: string | null): boolean {
    return validateGatewayToken(this.sql.bind(this), token)
  }

  /** Suppress Agent SDK protocol messages (identity, state, MCP) for gateway connections. */
  shouldSendProtocolMessages(_connection: Connection, ctx: ConnectionContext): boolean {
    const url = new URL(ctx.request.url)
    return url.searchParams.get('role') !== 'gateway'
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

      // If session was active, the connection dropped unexpectedly
      if (this.state.status === 'running' || this.state.status === 'waiting_gate') {
        this.recoverFromDroppedConnection()
      }
    }

    super.onClose(connection, code, reason, _wasClean)
  }

  // ── Gateway Connection ─────────────────────────────────────────

  /**
   * Trigger the gateway to dial back into this DO via outbound WS.
   * Generates a one-shot token, stores it in SQLite with 60s TTL,
   * then POSTs to the gateway's /sessions/start endpoint.
   */
  private async triggerGatewayDial(cmd: GatewayCommand) {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    const workerPublicUrl = this.env.WORKER_PUBLIC_URL
    if (!gatewayUrl || !workerPublicUrl) {
      console.error(`[SessionDO:${this.ctx.id}] CC_GATEWAY_URL or WORKER_PUBLIC_URL not configured`)
      this.updateState({ status: 'idle', error: 'Gateway URL or Worker URL not configured' })
      return
    }

    // Generate one-shot token with 60s TTL
    const token = crypto.randomUUID()
    const expiresAt = Date.now() + 60_000
    try {
      this.sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('gateway_token', ${token})`
      this
        .sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('gateway_token_expires', ${String(expiresAt)})`
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to store gateway token:`, err)
      this.updateState({ status: 'idle', error: 'Failed to store gateway token' })
      return
    }

    // Build callback URL: wss://worker-url/agents/session-agent/<do-id>?role=gateway&token=<token>
    const callbackUrl = buildGatewayCallbackUrl(workerPublicUrl, this.ctx.id.toString(), token)

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
        body: JSON.stringify({ callback_url: callbackUrl, cmd }),
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'unknown error')
        console.error(`[SessionDO:${this.ctx.id}] Gateway start failed: ${resp.status} ${errText}`)
        this.updateState({ status: 'idle', error: `Gateway start failed: ${resp.status}` })
        return
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

    if (staleDuration > STALE_THRESHOLD_MS && !gwConnId) {
      console.log(
        `[SessionDO:${this.ctx.id}] Watchdog: stale for ${Math.round(staleDuration / 1000)}s with no gateway connection — recovering`,
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

    // Transition to idle (session may be resumable via sdk_session_id)
    this.updateState({
      status: 'idle',
      gate: null,
      error: 'Gateway connection lost — session stopped. You can send a new message to resume.',
    })
    this.syncStatusToRegistry()

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

  private updateState(partial: Partial<SessionState>) {
    this.setState({
      ...this.state,
      ...partial,
      updated_at: new Date().toISOString(),
    })
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

  private broadcastMessage(message: SessionMessage) {
    this.broadcastToClients(JSON.stringify({ type: 'message', message }))
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

  private async syncStatusToRegistry() {
    try {
      const registryId = this.env.SESSION_REGISTRY.idFromName('default')
      const registry = this.env.SESSION_REGISTRY.get(registryId) as any
      await registry.updateSessionStatus(
        this.state.session_id ?? this.ctx.id.toString(),
        this.state.status,
      )
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync status to registry:`, err)
    }
  }

  private async syncResultToRegistry() {
    try {
      const registryId = this.env.SESSION_REGISTRY.idFromName('default')
      const registry = this.env.SESSION_REGISTRY.get(registryId) as any
      await registry.updateSessionResult(this.state.session_id ?? this.ctx.id.toString(), {
        summary: this.state.summary,
        duration_ms: this.state.duration_ms,
        total_cost_usd: this.state.total_cost_usd,
        num_turns: this.state.num_turns,
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync result to registry:`, err)
    }
  }

  private async syncSdkSessionIdToRegistry(sdkSessionId: string) {
    try {
      const sessionId = this.state.session_id ?? this.ctx.id.toString()
      const registryId = this.env.SESSION_REGISTRY.idFromName('default')
      const registry = this.env.SESSION_REGISTRY.get(registryId) as any
      await registry.updateSession(sessionId, { sdk_session_id: sdkSessionId })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync sdk_session_id to registry:`, err)
    }
  }

  private async syncDiscoveredToRegistry() {
    try {
      // Only sync if we have an sdk_session_id — otherwise there's nothing to link
      if (!this.state.sdk_session_id) return

      const registryId = this.env.SESSION_REGISTRY.idFromName('default')
      const registry = this.env.SESSION_REGISTRY.get(registryId) as any
      await registry.syncDiscoveredSessions(this.state.userId ?? 'system', [
        {
          sdk_session_id: this.state.sdk_session_id,
          agent: 'claude',
          project_dir: this.state.project_path || '',
          project: this.state.project || '',
          branch: '',
          started_at: this.state.started_at || this.state.created_at || new Date().toISOString(),
          last_activity: new Date().toISOString(),
          summary: this.state.summary || '',
          tag: null,
          title: null,
          message_count: this.state.num_turns,
          user: this.state.userId,
        },
      ])
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync discovered session:`, err)
    }
  }

  private async syncKataToRegistry(kataState: KataSessionState | null) {
    try {
      const registryId = this.env.SESSION_REGISTRY.idFromName('default')
      const registry = this.env.SESSION_REGISTRY.get(registryId) as any
      await registry.updateSession(this.state.session_id ?? this.ctx.id.toString(), {
        kata_mode: kataState?.currentMode ?? null,
        kata_issue: kataState?.issueNumber ?? null,
        kata_phase: kataState?.currentPhase ?? null,
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync kata state to registry:`, err)
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
            parts: [
              {
                type: 'text',
                text:
                  typeof content === 'string'
                    ? content
                    : Array.isArray(content)
                      ? content
                          .map((c: unknown) =>
                            typeof c === 'string'
                              ? c
                              : ((c as Record<string, unknown>)?.text ?? JSON.stringify(c)),
                          )
                          .join('')
                      : JSON.stringify(content),
              },
            ],
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
    const userId = this.state.userId
    if (!userId) return

    const vapidPublicKey = this.env.VAPID_PUBLIC_KEY
    const vapidPrivateKey = this.env.VAPID_PRIVATE_KEY
    const vapidSubject = this.env.VAPID_SUBJECT
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      console.log(`[SessionDO:${this.ctx.id}] Push not configured — skipping`)
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
      if (prefMap.get('push.enabled') === 'false') return

      // Event-specific toggle
      const prefKey = `push.${eventType}`
      if (prefMap.get(prefKey) === 'false') return
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to check push preferences:`, err)
      // Continue — default is opt-in (send notification)
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
      console.error(`[SessionDO:${this.ctx.id}] Failed to fetch push subscriptions:`, err)
      return
    }

    if (subscriptions.length === 0) return

    const vapid = { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject }

    // Send to all subscriptions (best-effort, no retry)
    for (const sub of subscriptions) {
      const result = await sendPushNotification(sub, payload, vapid)
      if (result.gone) {
        // 410 Gone — delete stale subscription
        try {
          await this.env.AUTH_DB.prepare('DELETE FROM push_subscriptions WHERE id = ?')
            .bind(sub.id)
            .run()
          console.log(`[SessionDO:${this.ctx.id}] Deleted stale push subscription ${sub.id}`)
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to delete stale subscription:`, err)
        }
      } else if (!result.ok) {
        console.log(
          `[SessionDO:${this.ctx.id}] Push to ${sub.endpoint.slice(0, 50)}... returned ${result.status}`,
        )
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

    this.setState({
      ...DEFAULT_STATE,
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
    })

    // Persist initial prompt as a user message so it survives reload
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage = {
      id: userMsgId,
      role: 'user',
      parts: contentToParts(config.prompt),
      createdAt: new Date(),
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

    this.setState({
      ...DEFAULT_STATE,
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
    })

    // Persist resume prompt as a user message
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage = {
      id: userMsgId,
      role: 'user',
      parts: [
        {
          type: 'text',
          text: typeof config.prompt === 'string' ? config.prompt : JSON.stringify(config.prompt),
        },
      ],
      createdAt: new Date(),
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
    this.updateState({ status: 'aborted', gate: null, error: reason ?? 'Stopped by user' })
    this.syncStatusToRegistry()

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

    this.updateState({ status: 'aborted', gate: null, error: reason ?? 'Aborted by user' })
    this.sendToGateway({ type: 'abort', session_id: this.state.session_id ?? '' })
    this.syncStatusToRegistry()
    console.log(`[SessionDO:${this.ctx.id}] abort: ${reason ?? 'user request'}`)
    return { ok: true }
  }

  @callable()
  async resolveGate(
    gateId: string,
    response: GateResponse,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'waiting_gate' && this.state.status !== 'idle') {
      return {
        ok: false,
        error: `Cannot resolve gate: status is '${this.state.status}', expected 'waiting_gate' or 'idle'`,
      }
    }

    if (!this.state.gate || this.state.gate.id !== gateId) {
      return {
        ok: false,
        error: `Stale gate ID: expected '${this.state.gate?.id}', got '${gateId}'`,
      }
    }

    const gate = this.state.gate

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

    // Update the message part state for the resolved gate
    if (this.currentTurnMessageId || this.turnCounter > 0) {
      const currentMsgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`
      const existing = this.session.getMessage(currentMsgId)
      if (existing) {
        const updatedParts = existing.parts.map((p) => {
          if (p.toolCallId === gateId) {
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
          }
          return p
        })
        const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
        try {
          this.session.updateMessage(updatedMsg)
          this.broadcastMessage(updatedMsg)
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to update gate resolution:`, err)
        }
      }
    }

    this.updateState({ status: 'running', gate: null })
    return { ok: true }
  }

  @callable()
  async sendMessage(content: string | ContentBlock[]): Promise<{ ok: boolean; error?: string }> {
    const { status } = this.state
    const isActive = status === 'running' || status === 'waiting_gate'
    const isResumable = status === 'idle' && this.state.sdk_session_id

    if (!isActive && !isResumable) {
      return { ok: false, error: `Cannot send message: status is '${status}'` }
    }

    // Persist user message
    this.turnCounter++
    const userMsgId = `usr-${this.turnCounter}`
    const userMsg: SessionMessage = {
      id: userMsgId,
      role: 'user',
      parts: contentToParts(content),
      createdAt: new Date(),
    }
    try {
      await this.session.appendMessage(userMsg)
      this.persistTurnState()
      this.broadcastMessage(userMsg)
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to persist user message:`, err)
    }

    if (isActive) {
      this.sendToGateway({
        type: 'stream-input',
        session_id: this.state.session_id ?? '',
        message: { role: 'user', content },
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

  @callable()
  async interrupt(): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running') {
      return { ok: false, error: `Cannot interrupt: status is '${this.state.status}'` }
    }
    this.sendToGateway({ type: 'interrupt', session_id: this.state.session_id ?? '' })
    return { ok: true }
  }

  @callable()
  async getContextUsage(): Promise<{ ok: boolean; error?: string }> {
    const gwConnId = this.getGatewayConnectionId()
    if (!gwConnId) {
      return { ok: false, error: 'No active gateway connection' }
    }
    this.sendToGateway({ type: 'get-context-usage', session_id: this.state.session_id ?? '' })
    return { ok: true }
  }

  @callable()
  async rewind(messageId: string): Promise<{ ok: boolean; error?: string }> {
    this.sendToGateway({
      type: 'rewind',
      session_id: this.state.session_id ?? '',
      message_id: messageId,
    })
    return { ok: true }
  }

  @callable()
  async getMessages(opts?: {
    offset?: number
    limit?: number
    session_hint?: string
    leafId?: string
  }) {
    // Self-initialize from registry for discovered sessions
    if (!this.state.sdk_session_id && opts?.session_hint) {
      try {
        const registryId = this.env.SESSION_REGISTRY.idFromName('default')
        const registry = this.env.SESSION_REGISTRY.get(registryId) as any
        const session = await registry.getSession(opts.session_hint)
        if (session?.sdk_session_id) {
          this.updateState({
            sdk_session_id: session.sdk_session_id,
            project: session.project ?? '',
            session_id: session.id,
            summary: session.summary ?? null,
            started_at: session.created_at || this.state.created_at || new Date().toISOString(),
            created_at: session.created_at || this.state.created_at || new Date().toISOString(),
          })
        }
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to init from registry:`, err)
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
  async getBranches(messageId: string): Promise<SessionMessage[]> {
    try {
      return this.session.getBranches(messageId)
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to get branches:`, err)
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
    const newUserMsg: SessionMessage = {
      id: newUserMsgId,
      role: 'user',
      parts: [{ type: 'text', text: newContent }],
      createdAt: new Date(),
    }

    try {
      this.session.appendMessage(newUserMsg, parentId)
      this.persistTurnState()
      this.broadcastMessage(newUserMsg)
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
        // Sync sdk_session_id to registry so discovery won't create a duplicate row
        if (event.sdk_session_id) this.syncSdkSessionIdToRegistry(event.sdk_session_id)
        break

      case 'partial_assistant': {
        const parts = partialAssistantToParts(event.content)
        const msgId = `msg-${this.turnCounter}`

        if (!this.currentTurnMessageId) {
          this.currentTurnMessageId = msgId

          // Check if message already exists (multi-response turn: assistant → tool → assistant)
          const existing = this.session.getMessage(msgId)
          if (existing) {
            // Merge streaming text into existing parts (preserving tool results)
            const updatedParts = [...existing.parts]
            for (const newPart of parts) {
              if (newPart.type === 'text') {
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
            // First partial of this turn — append new message
            const msg: SessionMessage = {
              id: msgId,
              role: 'assistant',
              parts,
              createdAt: new Date(),
            }
            try {
              this.session.appendMessage(msg, `usr-${this.turnCounter}`)
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
            // Merge streaming text: find existing streaming text parts and append
            const updatedParts = [...existing.parts]
            for (const newPart of parts) {
              if (newPart.type === 'text') {
                const existingTextIdx = updatedParts.findIndex(
                  (p) => p.type === 'text' && p.state === 'streaming',
                )
                if (existingTextIdx !== -1) {
                  updatedParts[existingTextIdx] = {
                    ...updatedParts[existingTextIdx],
                    text: (updatedParts[existingTextIdx].text ?? '') + (newPart.text ?? ''),
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

        // Merge: keep existing non-streaming parts (tool results from prior cycles),
        // replace streaming text with finalized content
        const existing = this.session.getMessage(msgId)
        let mergedParts: SessionMessagePart[]
        if (existing) {
          // Keep all non-streaming parts (tool results, file changes, etc.), drop streaming text
          const retained = existing.parts.filter((p) => p.state !== 'streaming')
          // Append the new finalized parts (text + tool_use from this response cycle)
          mergedParts = [...retained, ...newParts]
        } else {
          mergedParts = newParts
        }

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
            this.session.appendMessage(msg, `usr-${this.turnCounter}`)
          }
          this.currentTurnMessageId = null
          this.persistTurnState()
          this.broadcastMessage(msg)
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to persist assistant:`, err)
          this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
        }
        this.updateState({ num_turns: this.state.num_turns + 1 })
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
        // Add ask_user part to current assistant message
        const currentMsgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`
        const existing = this.session.getMessage(currentMsgId)
        if (existing) {
          const updatedParts: SessionMessagePart[] = [
            ...existing.parts,
            {
              type: 'tool-ask_user',
              toolCallId: event.tool_call_id,
              toolName: 'ask_user',
              input: { questions: event.questions },
              state: 'approval-requested',
            },
          ]
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            this.session.updateMessage(updatedMsg)
            this.broadcastMessage(updatedMsg)
          } catch (err) {
            console.error(`[SessionDO:${this.ctx.id}] Failed to persist ask_user:`, err)
            this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
          }
        }

        // PRESERVE existing side effects exactly
        this.updateState({
          status: 'waiting_gate',
          gate: {
            id: event.tool_call_id,
            type: 'ask_user',
            detail: { questions: event.questions },
          },
        })
        this.syncStatusToRegistry()
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
        // Add permission part to current assistant message
        const currentMsgId = this.currentTurnMessageId ?? `msg-${this.turnCounter}`
        const existing = this.session.getMessage(currentMsgId)
        if (existing) {
          const updatedParts: SessionMessagePart[] = [
            ...existing.parts,
            {
              type: 'tool-permission',
              toolCallId: event.tool_call_id,
              toolName: 'permission',
              input: { tool_name: event.tool_name, tool_call_id: event.tool_call_id },
              state: 'approval-requested',
            },
          ]
          const updatedMsg: SessionMessage = { ...existing, parts: updatedParts }
          try {
            this.session.updateMessage(updatedMsg)
            this.broadcastMessage(updatedMsg)
          } catch (err) {
            console.error(`[SessionDO:${this.ctx.id}] Failed to persist permission:`, err)
            this.broadcastToClients(JSON.stringify({ type: 'raw_event', event }))
          }
        }

        // PRESERVE all existing side effects (state update, registry sync, action token, push)
        this.updateState({
          status: 'waiting_gate',
          gate: {
            id: event.tool_call_id,
            type: 'permission_request',
            detail: { tool_name: event.tool_name, input: event.input },
          },
        })
        this.syncStatusToRegistry()
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

        // PRESERVE all existing side effects — always transition to idle
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
        this.syncStatusToRegistry()
        this.syncResultToRegistry()
        this.syncDiscoveredToRegistry()
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

        // PRESERVE existing side effects
        this.updateState({
          status: 'idle',
          gate: null,
          completed_at: new Date().toISOString(),
        })
        this.syncStatusToRegistry()
        break
      }

      case 'kata_state': {
        // PRESERVE existing side effects — store in kv and sync to registry
        try {
          this
            .sql`INSERT OR REPLACE INTO kv (key, value) VALUES ('kata_state', ${JSON.stringify(event.kata_state)})`
        } catch (err) {
          console.error(`[SessionDO:${this.ctx.id}] Failed to persist kata state:`, err)
        }
        this.syncKataToRegistry(event.kata_state)
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

        // Transition to idle (not failed) — session remains interactive
        this.updateState({ status: 'idle', error: event.error })
        this.syncStatusToRegistry()
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

      // Events that don't produce message parts — just broadcast raw
      default: {
        // context_usage, rewind_result, session_state_changed, rate_limit,
        // task_started, task_progress, task_notification — broadcast as-is
        this.broadcastGatewayEvent(event)
        break
      }
    }
  }
}
