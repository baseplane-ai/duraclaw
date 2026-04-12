import { Agent, type Connection, type ConnectionContext, callable } from 'agents'
import { generateActionToken } from '~/lib/action-token'
import { runMigrations } from '~/lib/do-migrations'
import { type PushPayload, sendPushNotification } from '~/lib/push'
import type {
  ContentBlock,
  Env,
  GateResponse,
  GatewayCommand,
  GatewayEvent,
  SessionState,
  SpawnConfig,
} from '~/lib/types'
import { connectToExecutor, parseEvent, sendCommand } from '~/lib/vps-client'
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
 * Broadcasts raw GatewayEvents to connected clients.
 * Uses @callable RPC methods for spawn, resolveGate, sendMessage, etc.
 */
export class SessionDO extends Agent<Env, SessionState> {
  initialState = DEFAULT_STATE
  private vpsWs: WebSocket | null = null

  // ── Lifecycle ──────────────────────────────────────────────────

  async onStart() {
    runMigrations(this.ctx.storage.sql, SESSION_DO_MIGRATIONS)
  }

  /**
   * Handle HTTP requests to the DO. The API route sends POST /create
   * to initialize and spawn a session without requiring a WS connection.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/create') {
      try {
        const body = (await request.json()) as SpawnConfig & { userId?: string }
        const userId = request.headers.get('x-user-id') ?? body.userId ?? null
        if (userId) {
          this.updateState({ userId })
        }
        const result = await this.spawn(body)
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
    const requestUserId = ctx.request.headers.get('x-user-id')
    if (!requestUserId || (this.state.userId && requestUserId !== this.state.userId)) {
      void connection.close()
      return
    }

    // Replay recent events from DO SQLite for reconnecting clients
    const events = this.sql<{ data: string }>`SELECT data FROM events ORDER BY id DESC LIMIT 50`
    for (const row of [...events].reverse()) {
      try {
        connection.send(JSON.stringify({ type: 'gateway_event', event: JSON.parse(row.data) }))
      } catch {
        // Skip malformed events
      }
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

  onMessage(connection: Connection, data: string | ArrayBuffer) {
    // Delegate to Agent base class for @callable RPC dispatch
    super.onMessage(connection, data)
  }

  // ── Gateway Connection ─────────────────────────────────────────

  private connectAndStream(cmd: GatewayCommand) {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    if (!gatewayUrl) {
      console.error(`[SessionDO:${this.ctx.id}] CC_GATEWAY_URL not configured`)
      this.updateState({ status: 'failed', error: 'CC_GATEWAY_URL not configured' })
      return
    }

    const ws = connectToExecutor(gatewayUrl, this.env.CC_GATEWAY_SECRET)

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const gatewayEvent = parseEvent(event.data)
        this.handleGatewayEvent(gatewayEvent)
      } catch (err) {
        console.error(`[SessionDO:${this.ctx.id}] Failed to parse gateway event:`, err)
      }
    })

    ws.addEventListener('close', () => {
      console.log(`[SessionDO:${this.ctx.id}] Gateway WS closed`)
      this.vpsWs = null
    })

    ws.addEventListener('error', (event: Event) => {
      console.error(`[SessionDO:${this.ctx.id}] Gateway WS error:`, event)
      this.vpsWs = null
      if (this.state.status === 'running' || this.state.status === 'waiting_gate') {
        this.updateState({ status: 'failed', error: 'Gateway connection error' })
        this.syncStatusToRegistry()
      }
    })

    ws.addEventListener('open', () => {
      sendCommand(ws, cmd)
    })

    this.vpsWs = ws
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
    for (const conn of this.getConnections()) {
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

  private persistEvent(event: GatewayEvent) {
    try {
      this
        .sql`INSERT INTO events (type, data, ts) VALUES (${event.type}, ${JSON.stringify(event)}, ${Date.now()})`
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to persist event:`, err)
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

  private sendToGateway(cmd: GatewayCommand) {
    if (this.vpsWs) {
      sendCommand(this.vpsWs, cmd)
    } else {
      console.error(`[SessionDO:${this.ctx.id}] Cannot send to gateway: no active connection`)
    }
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

    this.connectAndStream({
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

  @callable()
  async stop(reason?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'running' && this.state.status !== 'waiting_gate') {
      return { ok: false, error: `Cannot stop: status is '${this.state.status}'` }
    }

    if (this.vpsWs) {
      sendCommand(this.vpsWs, { type: 'stop', session_id: this.state.session_id ?? '' })
    } else {
      this.updateState({ status: 'stopped', gate: null })
      this.syncStatusToRegistry()
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

    if (this.vpsWs) {
      sendCommand(this.vpsWs, { type: 'abort', session_id: this.state.session_id ?? '' })
      this.vpsWs.close()
      this.vpsWs = null
    }

    this.syncStatusToRegistry()
    console.log(`[SessionDO:${this.ctx.id}] abort: ${reason ?? 'user request'}`)
    return { ok: true }
  }

  @callable()
  async resolveGate(
    gateId: string,
    response: GateResponse,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.state.status !== 'waiting_gate') {
      return {
        ok: false,
        error: `Cannot resolve gate: status is '${this.state.status}', expected 'waiting_gate'`,
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

    this.updateState({ status: 'running', gate: null })
    return { ok: true }
  }

  @callable()
  async sendMessage(content: string | ContentBlock[]): Promise<{ ok: boolean; error?: string }> {
    const { status } = this.state
    const isActive = status === 'running' || status === 'waiting_gate'
    const isResumable = (status === 'idle' || status === 'stopped') && this.state.sdk_session_id

    if (!isActive && !isResumable) {
      return { ok: false, error: `Cannot send message: status is '${status}'` }
    }

    if (isActive && this.vpsWs) {
      sendCommand(this.vpsWs, {
        type: 'stream-input',
        session_id: this.state.session_id ?? '',
        message: { role: 'user', content },
      })
    } else if (isResumable) {
      this.updateState({ status: 'running', gate: null, error: null })
      this.connectAndStream({
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
    if (!this.vpsWs) {
      return { ok: false, error: 'No active gateway connection' }
    }
    this.sendToGateway({ type: 'get-context-usage', session_id: this.state.session_id ?? '' })
    return { ok: true }
  }

  @callable()
  async rewind(messageId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.vpsWs) {
      sendCommand(this.vpsWs, {
        type: 'rewind',
        session_id: this.state.session_id ?? '',
        message_id: messageId,
      })
    }
    return { ok: true }
  }

  @callable()
  async getMessages(opts?: { offset?: number; limit?: number }) {
    const limit = opts?.limit ?? 200
    const offset = opts?.offset ?? 0

    // Derive ChatMessage objects from the events table.
    // The messages table was never populated — events is the source of truth.
    const rows = this.sql<{
      id: number
      type: string
      data: string
      ts: number
    }>`SELECT id, type, data, ts FROM events WHERE type IN ('assistant', 'tool_result') ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}`

    const messages: Array<{
      id: number | string
      role: string
      type: string
      content: string
      event_uuid: string | null
      created_at: string
    }> = []

    for (const row of rows) {
      try {
        const event = JSON.parse(row.data)
        if (row.type === 'assistant') {
          messages.push({
            id: event.uuid ?? row.id,
            role: 'assistant',
            type: 'text',
            content: JSON.stringify(event.content ?? []),
            event_uuid: event.uuid ?? null,
            created_at: new Date(row.ts).toISOString(),
          })
        } else if (row.type === 'tool_result') {
          messages.push({
            id: `tool-${event.uuid ?? row.id}`,
            role: 'tool',
            type: 'tool_result',
            content: JSON.stringify(event.content ?? []),
            event_uuid: event.uuid ?? null,
            created_at: new Date(row.ts).toISOString(),
          })
        }
      } catch {
        // Skip malformed event rows
      }
    }

    return messages
  }

  @callable()
  async getStatus() {
    const rows = this.sql<{
      id: number
      ts: string
      type: string
      data: string | null
    }>`SELECT id, ts, type, data FROM events ORDER BY id DESC LIMIT 50`
    return {
      state: this.state,
      recent_events: [...rows],
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
    // Persist every event for audit/replay
    this.persistEvent(event)

    // Broadcast raw event to all connected clients
    this.broadcastGatewayEvent(event)

    // Update state based on event type
    switch (event.type) {
      case 'session.init':
        this.updateState({ sdk_session_id: event.sdk_session_id, model: event.model })
        break

      case 'partial_assistant':
        // No state change needed — event is broadcast to clients
        break

      case 'assistant':
        this.updateState({ num_turns: this.state.num_turns + 1 })
        break

      case 'tool_result':
        // No state change needed
        break

      case 'ask_user':
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

      case 'permission_request':
        this.updateState({
          status: 'waiting_gate',
          gate: {
            id: event.tool_call_id,
            type: 'permission_request',
            detail: { tool_name: event.tool_name, input: event.input },
          },
        })
        this.syncStatusToRegistry()
        // Generate action token and dispatch push with it (fire-and-forget)
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

      case 'result':
        this.updateState({
          status: event.is_error ? 'failed' : 'idle',
          completed_at: new Date().toISOString(),
          result: event.result,
          duration_ms: (this.state.duration_ms ?? 0) + (event.duration_ms ?? 0),
          total_cost_usd: (this.state.total_cost_usd ?? 0) + (event.total_cost_usd ?? 0),
          num_turns: this.state.num_turns + (event.num_turns ?? 0),
          error: event.is_error ? event.result : null,
          summary: event.sdk_summary ?? this.state.summary,
          gate: null,
        })
        this.vpsWs?.close()
        this.vpsWs = null
        this.syncStatusToRegistry()
        this.syncResultToRegistry()
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

      case 'stopped':
        this.updateState({
          status: 'stopped',
          gate: null,
          completed_at: new Date().toISOString(),
        })
        this.vpsWs?.close()
        this.vpsWs = null
        this.syncStatusToRegistry()
        break

      case 'error':
        this.updateState({ status: 'failed', error: event.error })
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
  }
}
