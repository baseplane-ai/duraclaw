import type { GatewayCommand, GatewayEvent, ResumeCommand } from './types'

export function connectToExecutor(gatewayUrl: string, gatewaySecret?: string): WebSocket {
  const url = new URL(gatewayUrl)
  if (gatewaySecret) {
    url.searchParams.set('token', gatewaySecret)
  }
  return new WebSocket(url.toString())
}

export function sendCommand(ws: WebSocket, cmd: GatewayCommand | ResumeCommand): void {
  ws.send(JSON.stringify(cmd))
}

export function parseEvent(data: string | ArrayBuffer): GatewayEvent {
  const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
  return JSON.parse(raw) as GatewayEvent
}
