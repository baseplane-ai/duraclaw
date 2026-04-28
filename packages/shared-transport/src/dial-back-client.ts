import type { BufferedChannel } from './buffered-channel.js'

export interface DialBackClientLogger {
  info: (msg: string, ...rest: unknown[]) => void
  warn: (msg: string, ...rest: unknown[]) => void
  error: (msg: string, ...rest: unknown[]) => void
}

/**
 * Reasons passed to `onTerminate`. Extended over time as new terminal close
 * codes are added (e.g. `document_deleted` for `RepoDocumentDO` 4412 hard
 * delete). Subclasses register new mappings via the
 * `additionalTerminalCodes` constructor option.
 */
export type DialBackTerminateReason =
  | 'invalid_token'
  | 'token_rotated'
  | 'mode_transition'
  | 'reconnect_exhausted'
  | 'document_deleted'

export interface DialBackClientOptions {
  callbackUrl: string
  bearer: string
  channel: BufferedChannel
  onCommand: (cmd: unknown) => void
  onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'reconnecting') => void
  /** Optional session id included in structured log lines. Omitted if absent. */
  sessionId?: string
  /** Optional logger for structured logs. Defaults to `console`. */
  logger?: DialBackClientLogger
  /**
   * Called when the client gives up permanently — either the DO signalled a
   * terminal close code (4401 invalid token / 4410 token rotated / 4411 mode
   * transition / additionalTerminalCodes from a subclass) or we hit
   * MAX_POST_CONNECT_ATTEMPTS back-to-back reconnect failures after the
   * initial success. The session-runner uses this to exit cleanly instead of
   * spinning in a 30s reconnect loop forever (i.e. becoming an orphan).
   */
  onTerminate?: (reason: DialBackTerminateReason) => void
  /**
   * Subclass-supplied extra terminal close codes mapped to terminate reasons.
   * Used by `DialBackDocClient` to wire 4412 → 'document_deleted' without
   * teaching the parent class about doc-specific semantics.
   */
  additionalTerminalCodes?: ReadonlyMap<number, DialBackTerminateReason>
}

const BACKOFF_BASE = 1000
const BACKOFF_MULTIPLIER = 3
const BACKOFF_CAP = 30_000
const STABLE_THRESHOLD = 10_000
const STARTUP_TIMEOUT = 15 * 60 * 1000
/** After this many post-connect reconnect attempts with no 10s-stable window
 * in between, treat the DO as permanently unreachable and give up. */
const MAX_POST_CONNECT_ATTEMPTS = 20
/** WS close codes the DO uses to signal "don't reconnect, you're done". */
const CLOSE_INVALID_TOKEN = 4401
const CLOSE_TOKEN_ROTATED = 4410
const CLOSE_MODE_TRANSITION = 4411

export class DialBackClient {
  private callbackUrl: string
  private bearer: string
  protected channel: BufferedChannel
  private onCommand: (cmd: unknown) => void
  private onStateChange?: DialBackClientOptions['onStateChange']
  private onTerminate?: DialBackClientOptions['onTerminate']
  private sessionId?: string
  protected logger: DialBackClientLogger
  private additionalTerminalCodes: ReadonlyMap<number, DialBackTerminateReason>

  protected ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private healthTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = false
  private startedAt: number | null = null
  private hasEverConnected = false

  failedToConnect = false

  constructor(options: DialBackClientOptions) {
    this.callbackUrl = options.callbackUrl
    this.bearer = options.bearer
    this.channel = options.channel
    this.onCommand = options.onCommand
    this.onStateChange = options.onStateChange
    this.onTerminate = options.onTerminate
    this.sessionId = options.sessionId
    this.logger = options.logger ?? console
    this.additionalTerminalCodes = options.additionalTerminalCodes ?? new Map()
  }

  /**
   * Subclass hook called immediately after `new WebSocket(url)` and before
   * any handlers attach. Default: no-op. `DialBackDocClient` overrides to
   * set `binaryType = 'arraybuffer'`.
   */
  protected configureWebSocket(_ws: WebSocket): void {
    // no-op by default
  }

  /**
   * Subclass hook called from `onmessage` to convert the raw WS frame into
   * the value passed to `onCommand`. Default: `JSON.parse(data as string)`.
   * `DialBackDocClient` overrides to return `new Uint8Array(data as
   * ArrayBuffer)` (no JSON parsing).
   */
  protected parseIncoming(data: unknown): unknown {
    return JSON.parse(data as string)
  }

  private sessionSuffix(): string {
    return this.sessionId !== undefined ? ` sessionId=${this.sessionId}` : ''
  }

  start(): void {
    // Collision policy: if already connected, close old WS
    if (this.ws) {
      console.warn('DialBackClient: replacing existing WebSocket connection')
      this.channel.detachWebSocket()
      this.ws.close()
      this.ws = null
    }

    this.stopped = false
    this.startedAt = Date.now()
    this.failedToConnect = false
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.healthTimer !== null) {
      clearTimeout(this.healthTimer)
      this.healthTimer = null
    }
    if (this.ws) {
      this.channel.detachWebSocket()
      this.ws.close()
      this.ws = null
    }
    this.onStateChange?.('closed')
  }

  private connect(): void {
    if (this.stopped) return

    this.onStateChange?.(this.hasEverConnected ? 'reconnecting' : 'connecting')

    // Build URL with token query param
    const url = `${this.callbackUrl}${this.callbackUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.bearer)}`

    const ws = new WebSocket(url)
    this.ws = ws
    this.configureWebSocket(ws)

    ws.onopen = () => {
      if (this.stopped || ws !== this.ws) return
      const firstConnect = !this.hasEverConnected
      this.hasEverConnected = true
      this.channel.attachWebSocket(ws)
      this.onStateChange?.('open')

      this.logger.info(
        `[dial-back-client] connection established${this.sessionSuffix()}${firstConnect ? ' first=true' : ''}`,
      )

      // Reset backoff after connection stays healthy for 10s
      this.healthTimer = setTimeout(() => {
        this.attempt = 0
      }, STABLE_THRESHOLD)
    }

    ws.onclose = (e: { code?: number; reason?: string } = {}) => {
      if (this.stopped || ws !== this.ws) return
      this.channel.detachWebSocket()

      // Clear health timer
      if (this.healthTimer !== null) {
        clearTimeout(this.healthTimer)
        this.healthTimer = null
      }

      const code = e.code
      const reason = e.reason ?? ''
      this.logger.info(
        `[dial-back-client] connection dropped${this.sessionSuffix()} code=${code ?? '?'}${reason ? ` reason=${reason}` : ''}`,
      )

      // DO-sent terminal close codes: don't reconnect, don't orphan.
      if (
        code === CLOSE_INVALID_TOKEN ||
        code === CLOSE_TOKEN_ROTATED ||
        code === CLOSE_MODE_TRANSITION
      ) {
        this.stopped = true
        this.onStateChange?.('closed')
        const reason: DialBackTerminateReason =
          code === CLOSE_INVALID_TOKEN
            ? 'invalid_token'
            : code === CLOSE_TOKEN_ROTATED
              ? 'token_rotated'
              : 'mode_transition'
        this.onTerminate?.(reason)
        return
      }

      // Subclass-registered terminal codes (e.g. 4412 document_deleted on
      // RepoDocumentDO). Same semantics as the built-in terminal codes:
      // stop, emit 'closed', fire onTerminate, no reconnect.
      if (code !== undefined) {
        const extraReason = this.additionalTerminalCodes.get(code)
        if (extraReason !== undefined) {
          this.stopped = true
          this.onStateChange?.('closed')
          this.onTerminate?.(extraReason)
          return
        }
      }

      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // Error triggers close, so we handle reconnect there
    }

    ws.onmessage = (e: { data: unknown }) => {
      if (this.stopped || ws !== this.ws) return
      try {
        const parsed = this.parseIncoming(e.data)
        this.onCommand(parsed)
      } catch {
        console.warn('DialBackClient: failed to parse message', e.data)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return

    // Check startup timeout
    if (
      !this.hasEverConnected &&
      this.startedAt &&
      Date.now() - this.startedAt >= STARTUP_TIMEOUT
    ) {
      this.failedToConnect = true
      this.onStateChange?.('closed')
      return
    }

    // Post-connect reconnect cap: if we connected once but have failed more
    // than MAX_POST_CONNECT_ATTEMPTS times back-to-back without a 10s stable
    // window resetting this.attempt, give up. Runner should exit rather than
    // orphan on the VPS hammering the DO forever.
    if (this.hasEverConnected && this.attempt >= MAX_POST_CONNECT_ATTEMPTS) {
      this.stopped = true
      this.logger.warn(
        `[dial-back-client] reconnect exhausted${this.sessionSuffix()} attempts=${this.attempt} — giving up`,
      )
      this.onStateChange?.('closed')
      this.onTerminate?.('reconnect_exhausted')
      return
    }

    this.onStateChange?.('reconnecting')

    // Backoff: min(1000 * 3^attempt, 30000)
    const delay = Math.min(BACKOFF_BASE * BACKOFF_MULTIPLIER ** this.attempt, BACKOFF_CAP)
    this.attempt++

    this.logger.info(
      `[dial-back-client] reconnect attempt=${this.attempt} delay_ms=${delay}${this.sessionSuffix()}`,
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
