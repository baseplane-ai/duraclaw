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
