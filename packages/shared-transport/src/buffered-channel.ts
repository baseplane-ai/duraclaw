export interface BufferedChannelLogger {
  info: (msg: string, ...rest: unknown[]) => void
  warn: (msg: string, ...rest: unknown[]) => void
  error: (msg: string, ...rest: unknown[]) => void
}

export interface BufferedChannelOptions {
  maxEvents?: number
  maxBytes?: number
  onOverflow?: (dropped: GapSentinel) => void
  /** Optional session id included in structured log lines. Omitted if absent. */
  sessionId?: string
  /** Optional logger for structured logs. Defaults to `console`. */
  logger?: BufferedChannelLogger
  /**
   * When true, emit a `[buffered-channel] send sessionId=... depth=...` log on
   * every buffered send (hot path). Defaults to false to avoid drowning logs.
   * Overflow logs are always emitted regardless of this flag.
   */
  verbose?: boolean
}

export interface GapSentinel {
  type: 'gap'
  dropped_count: number
  from_seq: number
  to_seq: number
}

interface BufferEntry {
  seq: number
  serialized: string
  bytes: number
}

function byteLength(str: string): number {
  // Use TextEncoder for cross-platform byte length (works in both Node and browser)
  return new TextEncoder().encode(str).byteLength
}

export class BufferedChannel {
  private buffer: BufferEntry[] = []
  private ws: WebSocket | null = null
  private totalBytes = 0
  private maxEvents: number
  private maxBytes: number
  private onOverflow?: (dropped: GapSentinel) => void
  private pendingGap: GapSentinel | null = null
  private sessionId?: string
  private logger: BufferedChannelLogger
  private verbose: boolean

  constructor(options?: BufferedChannelOptions) {
    this.maxEvents = options?.maxEvents ?? 10_000
    this.maxBytes = options?.maxBytes ?? 50 * 1024 * 1024
    this.onOverflow = options?.onOverflow
    this.sessionId = options?.sessionId
    this.logger = options?.logger ?? console
    this.verbose = options?.verbose ?? false
  }

  get depth(): number {
    return this.buffer.length
  }

  get isAttached(): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  private sessionSuffix(): string {
    return this.sessionId !== undefined ? ` sessionId=${this.sessionId}` : ''
  }

  send(event: { seq: number; [k: string]: unknown }): void {
    const serialized = JSON.stringify(event)
    const bytes = byteLength(serialized)

    // If WS is attached and open, send directly
    if (this.ws && this.ws.readyState === 1) {
      // Oversized or not, send directly when attached
      this.ws.send(serialized)
      if (this.verbose) {
        this.logger.info(
          `[buffered-channel] send${this.sessionSuffix()} depth=${this.buffer.length}`,
        )
      }
      return
    }

    // Oversized single event — exceeds maxBytes on its own
    if (bytes > this.maxBytes) {
      // Drain buffer entirely
      for (const entry of this.buffer) {
        this.recordDrop(entry.seq)
      }
      this.buffer = []
      this.totalBytes = 0

      // WS not attached/open — drop with warning + gap sentinel
      console.warn(
        `BufferedChannel: dropping oversized event seq=${event.seq} (${bytes} bytes exceeds maxBytes=${this.maxBytes})`,
      )
      this.recordDrop(event.seq)
      return
    }

    // Evict oldest entries until both constraints are satisfied
    while (
      this.buffer.length > 0 &&
      (this.buffer.length >= this.maxEvents || this.totalBytes + bytes > this.maxBytes)
    ) {
      const evicted = this.buffer.shift()
      if (!evicted) break
      this.totalBytes -= evicted.bytes
      this.recordDrop(evicted.seq)
    }

    this.buffer.push({ seq: event.seq, serialized, bytes })
    this.totalBytes += bytes

    if (this.verbose) {
      this.logger.info(`[buffered-channel] send${this.sessionSuffix()} depth=${this.buffer.length}`)
    }
  }

  attachWebSocket(ws: WebSocket): void {
    this.ws = ws

    // Auto-detach on close
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.detachWebSocket()
      }
    })

    // Replay: first send gap sentinel if drops occurred
    if (this.pendingGap) {
      ws.send(JSON.stringify(this.pendingGap))
      this.pendingGap = null
    }

    // Then replay buffered events in order
    for (const entry of this.buffer) {
      ws.send(entry.serialized)
    }

    // Clear buffer after replay
    this.buffer = []
    this.totalBytes = 0
  }

  detachWebSocket(): void {
    this.ws = null
  }

  close(): void {
    this.detachWebSocket()
    this.buffer = []
    this.totalBytes = 0
    this.pendingGap = null
  }

  private recordDrop(seq: number): void {
    const isNewGap = this.pendingGap === null
    if (this.pendingGap) {
      this.pendingGap.dropped_count++
      this.pendingGap.to_seq = seq
    } else {
      this.pendingGap = {
        type: 'gap',
        dropped_count: 1,
        from_seq: seq,
        to_seq: seq,
      }
    }
    // Structured overflow log — emit on every drop so coalescing is visible
    // to operators. Unconditional (not gated on verbose) since overflow is
    // rare and important.
    this.logger.warn(
      `[buffered-channel] overflow${this.sessionSuffix()} dropped_count=${this.pendingGap.dropped_count} from_seq=${this.pendingGap.from_seq} to_seq=${this.pendingGap.to_seq}${isNewGap ? ' new_gap=true' : ''}`,
    )
    this.onOverflow?.(this.pendingGap)
  }
}
