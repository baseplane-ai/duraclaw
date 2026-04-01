import { Agent, type Connection, type ConnectionContext } from 'agents'
import type { UIMessageChunk } from 'ai'
import type {
  BrowserCommand,
  GatewayCommand,
  GatewayEvent,
  ResumeCommand,
  SessionState,
  StoredMessage,
} from '~/lib/types'

/**
 * Extended chunk type: AI SDK UIMessageChunk plus custom types
 * for history replay and file changes that the SDK doesn't cover.
 */
type SessionChunk =
  | UIMessageChunk
  | { type: 'history'; messages: StoredMessage[] }
  | { type: 'turn-complete' }
  | { type: 'file-changed'; path: string; tool: string; timestamp: string }

type ConnTag = { type: 'chat' } | { type: 'agent' }
import type { Env } from '~/lib/types'
import { connectToExecutor, parseEvent, sendCommand } from '~/lib/vps-client'

const DEFAULT_STATE: SessionState = {
  id: '',
  project: '',
  project_path: '',
  status: 'idle',
  model: null,
  prompt: '',
  created_at: '',
  updated_at: '',
  duration_ms: null,
  total_cost_usd: null,
  result: null,
  error: null,
  num_turns: null,
  sdk_session_id: null,
  pending_question: null,
  pending_permission: null,
  summary: null,
}

/**
 * SessionDO — one Durable Object per CC session.
 *
 * Implements bidirectional relay:
 *   Browser WS <-> SessionDO <-> Gateway WS
 *
 * Translates GatewayEvent to AI SDK UIMessageChunk for browser clients.
 */
export class SessionDO extends Agent<Env, SessionState> {
  initialState = DEFAULT_STATE
  private vpsWs: WebSocket | null = null

  // ── Gateway Connection ─────────────────────────────────────────

  private connectAndStream(cmd: GatewayCommand | ResumeCommand) {
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
      if (
        this.state.status === 'running' ||
        this.state.status === 'waiting_input' ||
        this.state.status === 'waiting_permission'
      ) {
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

  private broadcastToClients(chunk: SessionChunk) {
    const data = JSON.stringify(chunk)
    // Broadcast only to chat connections (not agent/PartySocket connections)
    for (const conn of this.getConnections()) {
      const tag = conn.state as ConnTag | undefined
      if (tag?.type !== 'agent') {
        try {
          conn.send(data)
        } catch {
          // Connection already closed
        }
      }
    }
  }

  private async syncStatusToRegistry() {
    try {
      const registryId = this.env.SESSION_REGISTRY.idFromName('default')
      const registry = this.env.SESSION_REGISTRY.get(registryId) as any
      await registry.updateSessionStatus(this.state.id, this.state.status)
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync status to registry:`, err)
    }
  }

  private async syncResultToRegistry() {
    try {
      const registryId = this.env.SESSION_REGISTRY.idFromName('default')
      const registry = this.env.SESSION_REGISTRY.get(registryId) as any
      await registry.updateSessionResult(this.state.id, {
        summary: this.state.summary,
        duration_ms: this.state.duration_ms,
        total_cost_usd: this.state.total_cost_usd,
        num_turns: this.state.num_turns,
      })
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to sync result to registry:`, err)
    }
  }

  // ── HTTP Request Handler (for non-WS calls) ────────────────────

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/create' && request.method === 'POST') {
      const config = await request.json() as Parameters<SessionDO['create']>[0]
      await this.create(config)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.pathname === '/state' && request.method === 'GET') {
      return new Response(JSON.stringify(this.state), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.pathname === '/messages' && request.method === 'GET') {
      const messages = this.sql<StoredMessage>`SELECT * FROM messages ORDER BY id ASC`
      return new Response(JSON.stringify(messages), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.pathname === '/abort' && request.method === 'POST') {
      try {
        await this.abort()
      } catch {
        // Force abort even if state check fails (e.g. zombie sessions)
        this.updateState({ status: 'aborted', pending_question: null, pending_permission: null })
        this.vpsWs?.close()
        this.vpsWs = null
        this.syncStatusToRegistry()
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not found', { status: 404 })
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async onStart() {
    // Create messages table with role column (idempotent)
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL DEFAULT 'assistant',
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`

    // If session was running when DO was evicted, schedule reconnect
    if (
      this.state.status === 'running' ||
      this.state.status === 'waiting_input' ||
      this.state.status === 'waiting_permission'
    ) {
      await this.schedule(5, 'reconnectVps')
    }
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    // Tag connection type based on URL path
    const url = new URL(ctx.request.url)
    const isAgent = url.pathname.endsWith('/agent')
    connection.setState({ type: isAgent ? 'agent' : 'chat' } satisfies ConnTag)

    // Agent (PartySocket) connections only need state sync — handled by Agent base class
    if (isAgent) return

    // Chat connections get full message history replay
    const messages = this.sql<StoredMessage>`SELECT * FROM messages ORDER BY id ASC`
    connection.send(
      JSON.stringify({ type: 'history', messages } satisfies SessionChunk),
    )

    // Re-emit pending question if any
    if (this.state.pending_question && this.state.status === 'waiting_input') {
      connection.send(
        JSON.stringify({
          type: 'tool-input-available',
          toolCallId: 'pending-question',
          toolName: 'AskUserQuestion',
          input: { questions: this.state.pending_question },
        } satisfies SessionChunk),
      )
    }

    if (this.state.pending_permission && this.state.status === 'waiting_permission') {
      const perm = this.state.pending_permission
      connection.send(
        JSON.stringify({
          type: 'tool-approval-request',
          approvalId: perm.tool_call_id,
          toolCallId: perm.tool_call_id,
        } satisfies SessionChunk),
      )
    }
  }

  onMessage(connection: Connection, data: string | ArrayBuffer) {
    // Agent (PartySocket) connections use RPC — skip raw message handling
    const tag = connection.state as ConnTag | undefined
    if (tag?.type === 'agent') return

    try {
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
      const cmd = JSON.parse(raw) as BrowserCommand

      switch (cmd.type) {
        case 'user-message': {
          // Store user message
          this.sql`INSERT INTO messages (role, type, data) VALUES ('user', 'user-message', ${JSON.stringify({ content: cmd.content })})`

          if (this.state.status === 'idle' && this.state.sdk_session_id) {
            // Resume session with follow-up message
            this.updateState({ status: 'running' })
            this.broadcastToClients({ type: 'status', status: 'running' } as any)
            this.connectAndStream({
              type: 'resume',
              project: this.state.project,
              prompt: cmd.content,
              sdk_session_id: this.state.sdk_session_id,
            })
          } else if (this.state.status === 'running' && this.vpsWs) {
            // Relay to running gateway session as stream-input
            sendCommand(this.vpsWs, {
              type: 'stream-input',
              session_id: this.state.id,
              message: { role: 'user', content: cmd.content },
            })
          }
          break
        }

        case 'tool-approval': {
          if (cmd.answers) {
            // AskUserQuestion answer
            if (this.vpsWs && this.state.status === 'waiting_input') {
              sendCommand(this.vpsWs, {
                type: 'answer',
                session_id: this.state.id,
                tool_call_id: cmd.toolCallId,
                answers: cmd.answers,
              })
              this.updateState({ status: 'running', pending_question: null })
            }
          } else {
            // Permission response
            if (this.vpsWs && this.state.status === 'waiting_permission') {
              sendCommand(this.vpsWs, {
                type: 'permission-response',
                session_id: this.state.id,
                tool_call_id: cmd.toolCallId,
                allowed: cmd.approved,
              })
              this.updateState({ status: 'running', pending_permission: null })
            }
          }
          break
        }
      }
    } catch (err) {
      console.error(`[SessionDO:${this.ctx.id}] Failed to handle browser message:`, err)
    }
  }

  // ── Scheduled Callbacks ────────────────────────────────────────

  async reconnectVps() {
    console.log(`[SessionDO:${this.ctx.id}] reconnectVps`)
    const activeStates = ['running', 'waiting_input', 'waiting_permission']
    if (!activeStates.includes(this.state.status)) return

    if (!this.state.sdk_session_id) {
      this.updateState({ status: 'failed', error: 'Cannot reconnect: no sdk_session_id' })
      this.syncStatusToRegistry()
      return
    }

    this.connectAndStream({
      type: 'resume',
      project: this.state.project,
      prompt: this.state.prompt,
      sdk_session_id: this.state.sdk_session_id,
    })
  }

  // ── RPC Methods ────────────────────────────────────────────────

  async create(config: {
    project: string
    project_path: string
    prompt: string
    model?: string
    system_prompt?: string
    allowed_tools?: string[]
    max_turns?: number
    max_budget_usd?: number
  }) {
    const now = new Date().toISOString()
    const id = this.ctx.id.toString()
    this.setState({
      ...DEFAULT_STATE,
      id,
      project: config.project,
      project_path: config.project_path,
      status: 'running',
      model: config.model ?? null,
      prompt: config.prompt,
      created_at: now,
      updated_at: now,
    })

    // Store initial user message
    this.sql`INSERT INTO messages (role, type, data) VALUES ('user', 'user-message', ${JSON.stringify({ content: config.prompt })})`

    this.connectAndStream({
      type: 'execute',
      project: config.project,
      prompt: config.prompt,
      model: config.model,
      system_prompt: config.system_prompt,
      allowed_tools: config.allowed_tools,
      max_turns: config.max_turns,
      max_budget_usd: config.max_budget_usd,
    })
    console.log(`[SessionDO:${id}] create: ${config.project} "${config.prompt}"`)
  }

  async abort() {
    const activeStates = ['running', 'waiting_input', 'waiting_permission']
    if (!activeStates.includes(this.state.status)) {
      throw new Error('Session is not in an abortable state')
    }

    this.updateState({ status: 'aborted', pending_question: null, pending_permission: null })

    if (this.vpsWs) {
      sendCommand(this.vpsWs, { type: 'abort', session_id: this.state.id })
      this.vpsWs.close()
      this.vpsWs = null
    }

    this.syncStatusToRegistry()
    this.broadcastToClients({ type: 'finish' })
    console.log(`[SessionDO:${this.ctx.id}] abort`)
  }

  async getSessionState(): Promise<SessionState> {
    return this.state
  }

  async getMessages(): Promise<StoredMessage[]> {
    return this.sql<StoredMessage>`SELECT * FROM messages ORDER BY id ASC`
  }

  async cleanup() {
    this.sql`DROP TABLE IF EXISTS messages`
    await this.ctx.storage.deleteAll()
  }

  // ── Gateway Event Handling ─────────────────────────────────────

  handleGatewayEvent(event: GatewayEvent) {
    switch (event.type) {
      case 'session.init':
        this.updateState({ sdk_session_id: event.sdk_session_id, model: event.model })
        // Emit start chunk to frame the assistant turn
        this.broadcastToClients({ type: 'start' })
        break

      case 'partial_assistant': {
        // Translate to AI SDK UIMessageChunk and broadcast
        const chunks = gatewayEventToChunks(event)
        for (const chunk of chunks) {
          this.broadcastToClients(chunk)
        }
        break
      }

      case 'assistant':
        // Store complete message (not partials)
        this.sql`INSERT INTO messages (role, type, data) VALUES ('assistant', 'assistant', ${JSON.stringify(event)})`
        // Emit text-end for any open text parts
        this.broadcastToClients({ type: 'text-end', id: event.uuid })
        this.updateState({})
        break

      case 'tool_result':
        this.sql`INSERT INTO messages (role, type, data) VALUES ('tool', 'tool_result', ${JSON.stringify(event)})`
        // Broadcast tool output (AI SDK format)
        this.broadcastToClients({
          type: 'tool-output-available',
          toolCallId: event.uuid,
          output: event.content,
        })
        this.updateState({})
        break

      case 'ask_user':
        this.updateState({
          status: 'waiting_input',
          pending_question: event.questions,
        })
        // Questions go through tool-input-available with AskUserQuestion name
        this.broadcastToClients({
          type: 'tool-input-available',
          toolCallId: event.tool_call_id,
          toolName: 'AskUserQuestion',
          input: { questions: event.questions },
        })
        break

      case 'permission_request':
        this.updateState({
          status: 'waiting_permission',
          pending_permission: {
            tool_call_id: event.tool_call_id,
            tool_name: event.tool_name,
            input: event.input,
          },
        })
        // Emit tool-input-available so the client sees the tool, then approval request
        this.broadcastToClients({
          type: 'tool-input-available',
          toolCallId: event.tool_call_id,
          toolName: event.tool_name,
          input: event.input,
        })
        this.broadcastToClients({
          type: 'tool-approval-request',
          approvalId: event.tool_call_id,
          toolCallId: event.tool_call_id,
        })
        break

      case 'file_changed':
        this.broadcastToClients({
          type: 'file-changed',
          path: event.path,
          tool: event.tool,
          timestamp: event.timestamp,
        })
        break

      case 'result':
        this.updateState({
          status: event.is_error ? 'failed' : 'idle',
          result: event.result,
          duration_ms: (this.state.duration_ms ?? 0) + (event.duration_ms ?? 0),
          total_cost_usd: (this.state.total_cost_usd ?? 0) + (event.total_cost_usd ?? 0),
          num_turns: (this.state.num_turns ?? 0) + (event.num_turns ?? 0),
          error: event.is_error ? event.result : null,
          summary: event.sdk_summary ?? this.state.summary,
        })
        this.vpsWs?.close()
        this.vpsWs = null
        // Emit AI SDK finish chunk + custom turn-complete
        this.broadcastToClients({
          type: 'finish',
          finishReason: event.is_error ? 'error' : 'stop',
        })
        this.broadcastToClients({ type: 'turn-complete' })
        this.syncStatusToRegistry()
        this.syncResultToRegistry()
        break

      case 'error':
        this.updateState({ status: 'failed', error: event.error })
        this.broadcastToClients({ type: 'error', errorText: event.error })
        this.broadcastToClients({ type: 'finish', finishReason: 'error' })
        this.syncStatusToRegistry()
        break
    }
  }

  // ── RPC Methods for Agent State (called from useAgent client) ──

  async submitToolApproval(args: { toolCallId: string; approved: boolean }) {
    if (!this.vpsWs || this.state.status !== 'waiting_permission') return
    sendCommand(this.vpsWs, {
      type: 'permission-response',
      session_id: this.state.id,
      tool_call_id: args.toolCallId,
      allowed: args.approved,
    })
    this.updateState({ status: 'running', pending_permission: null })
    if (!args.approved) {
      this.broadcastToClients({ type: 'tool-output-denied', toolCallId: args.toolCallId })
    }
  }

  async submitAnswers(args: { toolCallId: string; answers: Record<string, string> }) {
    if (!this.vpsWs || this.state.status !== 'waiting_input') return
    sendCommand(this.vpsWs, {
      type: 'answer',
      session_id: this.state.id,
      tool_call_id: args.toolCallId,
      answers: args.answers,
    })
    this.updateState({ status: 'running', pending_question: null })
  }
}

// ── Protocol Translation (GatewayEvent → AI SDK UIMessageChunk) ──────

function gatewayEventToChunks(event: GatewayEvent): SessionChunk[] {
  if (event.type !== 'partial_assistant') return []

  const chunks: SessionChunk[] = []
  for (const block of event.content) {
    if (block.type === 'text') {
      if (block.delta) {
        chunks.push({ type: 'text-delta', id: block.id, delta: block.delta })
      }
    } else if (block.type === 'tool_use') {
      if (block.tool_name) {
        chunks.push({
          type: 'tool-input-start',
          toolCallId: block.id,
          toolName: block.tool_name,
        })
      }
      if (block.input_delta) {
        chunks.push({
          type: 'tool-input-delta',
          toolCallId: block.id,
          inputTextDelta: block.input_delta,
        })
      }
    }
  }
  return chunks
}
