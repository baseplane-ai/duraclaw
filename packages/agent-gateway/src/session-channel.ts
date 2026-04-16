import type { ServerWebSocket } from 'bun'
import type { WsData } from './types.js'

/**
 * Unified channel abstraction over both Bun ServerWebSocket (inbound)
 * and Bun outbound WebSocket (dial-back connections).
 */
export interface SessionChannel {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}

/** Wraps Bun ServerWebSocket for existing direct WS connections. */
export function fromServerWebSocket(ws: ServerWebSocket<WsData>): SessionChannel {
  return {
    send(data: string) {
      ws.send(data)
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason)
    },
    get readyState() {
      return ws.readyState
    },
  }
}

/** Wraps Bun outbound WebSocket for dial-back connections. */
export function fromWebSocket(ws: WebSocket): SessionChannel {
  return {
    send(data: string) {
      ws.send(data)
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason)
    },
    get readyState() {
      return ws.readyState
    },
  }
}

/**
 * A SessionChannel that supports swapping the underlying WebSocket.
 * Used for dial-back connections where reconnects replace the WS.
 */
export class ReconnectableChannel implements SessionChannel {
  private ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  send(data: string): void {
    this.ws.send(data)
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }

  get readyState(): number {
    return this.ws.readyState
  }

  /** Swap the underlying WebSocket (e.g., after reconnect). */
  replaceWebSocket(ws: WebSocket): void {
    this.ws = ws
  }
}
