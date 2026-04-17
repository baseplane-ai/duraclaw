import type { BufferedChannel } from './buffered-channel.js'

export interface DialBackClientOptions {
  callbackUrl: string
  bearer: string
  channel: BufferedChannel
  onCommand: (cmd: unknown) => void
  onStateChange?: (state: 'connecting' | 'open' | 'closed' | 'reconnecting') => void
}

const BACKOFF_BASE = 1000
const BACKOFF_MULTIPLIER = 3
const BACKOFF_CAP = 30_000
const STABLE_THRESHOLD = 10_000
const STARTUP_TIMEOUT = 15 * 60 * 1000

export class DialBackClient {
  private callbackUrl: string
  private bearer: string
  private channel: BufferedChannel
  private onCommand: (cmd: unknown) => void
  private onStateChange?: DialBackClientOptions['onStateChange']

  private ws: WebSocket | null = null
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

    ws.onopen = () => {
      if (this.stopped || ws !== this.ws) return
      this.hasEverConnected = true
      this.channel.attachWebSocket(ws)
      this.onStateChange?.('open')

      // Reset backoff after connection stays healthy for 10s
      this.healthTimer = setTimeout(() => {
        this.attempt = 0
      }, STABLE_THRESHOLD)
    }

    ws.onclose = () => {
      if (this.stopped || ws !== this.ws) return
      this.channel.detachWebSocket()

      // Clear health timer
      if (this.healthTimer !== null) {
        clearTimeout(this.healthTimer)
        this.healthTimer = null
      }

      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // Error triggers close, so we handle reconnect there
    }

    ws.onmessage = (e: { data: string }) => {
      if (this.stopped || ws !== this.ws) return
      try {
        const parsed = JSON.parse(e.data as string)
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

    this.onStateChange?.('reconnecting')

    // Backoff: min(1000 * 3^attempt, 30000)
    const delay = Math.min(BACKOFF_BASE * BACKOFF_MULTIPLIER ** this.attempt, BACKOFF_CAP)
    this.attempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
