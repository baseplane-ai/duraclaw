import type { VpsCommand, VpsEvent } from './types'

/**
 * Open a WebSocket to the VPS executor.
 * Returns the WebSocket instance. The caller is responsible for
 * handling messages and cleanup.
 */
export function connectToExecutor(gatewayUrl: string, gatewaySecret?: string): WebSocket {
  // Append token as query param for WS upgrade auth
  const url = new URL(gatewayUrl)
  if (gatewaySecret) {
    url.searchParams.set('token', gatewaySecret)
  }

  return new WebSocket(url.toString())
}

/** Send a typed command over the WebSocket */
export function sendCommand(ws: WebSocket, cmd: VpsCommand): void {
  ws.send(JSON.stringify(cmd))
}

/** Parse a WebSocket message as a VpsEvent */
export function parseEvent(data: string | ArrayBuffer): VpsEvent {
  const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
  return JSON.parse(raw) as VpsEvent
}
