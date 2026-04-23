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
  /**
   * Spec GH#75 B8 — sidecar persistence for the pending gap sentinel.
   * Called with the current `pendingGap` after every `recordDrop`, and with
   * `null` after a successful sentinel send on WS attach. Fire-and-forget:
   * the channel awaits the returned promise inside an async IIFE so the
   * sync send / attachWebSocket paths do not block; rejections are logged
   * via the injected logger, never thrown.
   */
  persistGap?: (gap: GapSentinel | null) => void | Promise<void>
  /**
   * Spec GH#75 B8 — if a `.gap` sidecar was present from a prior crashed
   * runner, pass the parsed sentinel here so it is seeded into pendingGap
   * at construction. It will be sent as the first frame on the next
   * successful `attachWebSocket`.
   */
  initialPendingGap?: GapSentinel | null
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
  private persistGap?: (gap: GapSentinel | null) => void | Promise<void>

  constructor(options?: BufferedChannelOptions) {
    this.maxEvents = options?.maxEvents ?? 10_000
    this.maxBytes = options?.maxBytes ?? 50 * 1024 * 1024
    this.onOverflow = options?.onOverflow
    this.sessionId = options?.sessionId
    this.logger = options?.logger ?? console
    this.verbose = options?.verbose ?? false
    this.persistGap = options?.persistGap
    // Spec GH#75 B8 — seed any pre-crash sidecar sentinel so the next
    // attachWebSocket sends it as the first frame.
    if (options?.initialPendingGap) {
      this.pendingGap = options.initialPendingGap
    }
  }

  /**
   * Spec GH#75 B8 — fire-and-forget invocation of the persistGap callback.
   * Rejections are logged but never surfaced to the caller so send()/
   * attachWebSocket() cannot be destabilized by a flaky sidecar write.
   */
  private schedulePersistGap(gap: GapSentinel | null): void {
    if (!this.persistGap) return
    const cb = this.persistGap
    void (async () => {
      try {
        await cb(gap)
      } catch (err) {
        this.logger.warn(
          `[buffered-channel] persistGap failed${this.sessionSuffix()} err=${(err as Error).message}`,
        )
      }
    })()
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
      // Spec GH#75 B8 — clear the sidecar only after a successful send. If
      // ws.send threw above, we never reach here and the sidecar persists so
      // the next attach/restart can still replay the sentinel.
      this.schedulePersistGap(null)
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
    // Spec GH#75 B8 — persist the (coalesced) sentinel so a runner crash
    // between this drop and the next attachWebSocket does not swallow it.
    this.schedulePersistGap(this.pendingGap)
  }
}
