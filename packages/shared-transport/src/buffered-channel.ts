export interface BufferedChannelOptions {
  maxEvents?: number
  maxBytes?: number
  onOverflow?: (dropped: GapSentinel) => void
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

  constructor(options?: BufferedChannelOptions) {
    this.maxEvents = options?.maxEvents ?? 10_000
    this.maxBytes = options?.maxBytes ?? 50 * 1024 * 1024
    this.onOverflow = options?.onOverflow
  }

  get depth(): number {
    return this.buffer.length
  }

  get isAttached(): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  send(event: { seq: number; [k: string]: unknown }): void {
    const serialized = JSON.stringify(event)
    const bytes = byteLength(serialized)

    // If WS is attached and open, send directly
    if (this.ws && this.ws.readyState === 1) {
      // Oversized or not, send directly when attached
      this.ws.send(serialized)
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
    this.onOverflow?.(this.pendingGap)
  }
}
