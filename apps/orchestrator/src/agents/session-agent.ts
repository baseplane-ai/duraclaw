import { Agent, type Connection } from 'agents'
import type { Env, SessionState, VpsCommand, VpsEvent } from '~/lib/types'
import { connectToExecutor, parseEvent, sendCommand } from '~/lib/vps-client'

const DEFAULT_STATE: SessionState = {
  id: '',
  worktree: '',
  worktree_path: '',
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
}

/**
 * SessionAgent — one Durable Object per CC session.
 *
 * Owns session state, maintains WebSocket to browser client(s) via
 * setState() auto-broadcast, and connects to VPS executor for SDK
 * execution.
 *
 * Any CF worker with the SESSION_AGENT binding can drive the full
 * lifecycle via RPC: create, resume, abort, answer, getState, destroy.
 */
export class SessionAgent extends Agent<Env, SessionState> {
  initialState = DEFAULT_STATE
  private vpsWs: WebSocket | null = null

  /** Open a WS to the VPS executor, wire up event handling, and send a command */
  private connectAndStream(cmd: VpsCommand) {
    const gatewayUrl = this.env.CC_GATEWAY_URL
    if (!gatewayUrl) {
      console.error(`[SessionAgent:${this.ctx.id}] CC_GATEWAY_URL not configured`)
      this.setState({
        ...this.state,
        status: 'failed',
        error: 'CC_GATEWAY_URL not configured',
        updated_at: new Date().toISOString(),
      })
      return
    }

    const ws = connectToExecutor(gatewayUrl, this.env.CC_GATEWAY_SECRET)

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const vpsEvent = parseEvent(event.data)
        this.handleVpsEvent(vpsEvent)
      } catch (err) {
        console.error(`[SessionAgent:${this.ctx.id}] Failed to parse VPS event:`, err)
      }
    })

    ws.addEventListener('close', () => {
      console.log(`[SessionAgent:${this.ctx.id}] VPS WebSocket closed`)
      this.vpsWs = null
    })

    ws.addEventListener('error', (event: Event) => {
      console.error(`[SessionAgent:${this.ctx.id}] VPS WebSocket error:`, event)
      this.vpsWs = null
      // Mark session as failed if still running
      if (this.state.status === 'running') {
        this.setState({
          ...this.state,
          status: 'failed',
          error: 'VPS executor connection error',
          updated_at: new Date().toISOString(),
        })
      }
    })

    ws.addEventListener('open', () => {
      sendCommand(ws, cmd)
    })

    this.vpsWs = ws
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async onStart() {
    // Create messages table on every wake (idempotent)
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`

    // If session was running when DO was evicted, schedule reconnect
    if (this.state.status === 'running') {
      await this.schedule(5, 'reconnectVps')
    }
  }

  onConnect(connection: Connection) {
    // Re-emit pending question if any
    if (this.state.pending_question) {
      connection.send(
        JSON.stringify({
          type: 'user_question',
          session_id: this.state.id,
          questions: this.state.pending_question,
        }),
      )
    }
    // State snapshot is auto-sent by the SDK via protocol messages
  }

  // ── Scheduled Callbacks ────────────────────────────────────────

  async reconnectVps() {
    console.log(`[SessionAgent:${this.ctx.id}] reconnectVps`)
    if (this.state.status !== 'running') return

    if (!this.state.sdk_session_id) {
      this.setState({
        ...this.state,
        status: 'failed',
        error: 'Cannot reconnect: no sdk_session_id',
        updated_at: new Date().toISOString(),
      })
      return
    }

    this.connectAndStream({
      type: 'resume',
      worktree: this.state.worktree,
      prompt: this.state.prompt,
      sdk_session_id: this.state.sdk_session_id,
    })
  }

  // ── RPC Methods (callable from any CF worker via binding) ──────

  async create(config: {
    worktree: string
    worktree_path: string
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
      worktree: config.worktree,
      worktree_path: config.worktree_path,
      status: 'running',
      model: config.model ?? null,
      prompt: config.prompt,
      created_at: now,
      updated_at: now,
    })

    this.connectAndStream({
      type: 'execute',
      worktree: config.worktree,
      prompt: config.prompt,
      model: config.model,
      system_prompt: config.system_prompt,
      allowed_tools: config.allowed_tools,
      max_turns: config.max_turns,
      max_budget_usd: config.max_budget_usd,
    })
    console.log(`[SessionAgent:${id}] create: ${config.worktree} "${config.prompt}"`)
  }

  async resume(prompt: string) {
    if (this.state.status === 'running') {
      throw new Error('Session is already running')
    }
    if (!this.state.sdk_session_id) {
      throw new Error('No SDK session to resume')
    }

    this.setState({
      ...this.state,
      status: 'running',
      prompt,
      updated_at: new Date().toISOString(),
    })

    this.connectAndStream({
      type: 'resume',
      worktree: this.state.worktree,
      prompt,
      sdk_session_id: this.state.sdk_session_id as string,
    })
    console.log(`[SessionAgent:${this.ctx.id}] resume: "${prompt}"`)
  }

  async abort() {
    if (this.state.status !== 'running') {
      throw new Error('Session is not running')
    }

    this.setState({
      ...this.state,
      status: 'aborted',
      updated_at: new Date().toISOString(),
    })

    if (this.vpsWs) {
      sendCommand(this.vpsWs, { type: 'abort', session_id: this.state.id })
      this.vpsWs.close()
      this.vpsWs = null
    }
    console.log(`[SessionAgent:${this.ctx.id}] abort`)
  }

  async answer(answers: Record<string, string>) {
    if (!this.state.pending_question) {
      throw new Error('No pending question')
    }

    this.setState({
      ...this.state,
      pending_question: null,
      updated_at: new Date().toISOString(),
    })

    if (this.vpsWs) {
      sendCommand(this.vpsWs, { type: 'answer', session_id: this.state.id, answers })
    }
    console.log(`[SessionAgent:${this.ctx.id}] answer:`, answers)
  }

  async getSessionState(): Promise<SessionState> {
    return this.state
  }

  async cleanup() {
    // Clean up all storage
    this.sql`DROP TABLE IF EXISTS messages`
    await this.ctx.storage.deleteAll()
  }

  // ── VPS Event Handling ────────────────────────────────────────

  handleVpsEvent(event: VpsEvent) {
    switch (event.type) {
      case 'session.init':
        this.setState({
          ...this.state,
          sdk_session_id: event.sdk_session_id,
          model: event.model,
          updated_at: new Date().toISOString(),
        })
        break

      case 'assistant':
      case 'tool_result':
        // Store in SQL for history; state change triggers broadcast to clients
        this.sql`INSERT INTO messages (type, data) VALUES (${event.type}, ${JSON.stringify(event)})`
        // Touch updated_at to trigger state broadcast
        this.setState({
          ...this.state,
          updated_at: new Date().toISOString(),
        })
        break

      case 'user_question':
        this.setState({
          ...this.state,
          pending_question: event.questions,
          updated_at: new Date().toISOString(),
        })
        break

      case 'result':
        this.setState({
          ...this.state,
          status: event.is_error ? 'failed' : 'completed',
          result: event.result,
          duration_ms: event.duration_ms,
          total_cost_usd: event.total_cost_usd,
          num_turns: event.num_turns,
          error: event.is_error ? event.result : null,
          updated_at: new Date().toISOString(),
        })
        break

      case 'error':
        this.setState({
          ...this.state,
          status: 'failed',
          error: event.error,
          updated_at: new Date().toISOString(),
        })
        break
    }
  }
}
