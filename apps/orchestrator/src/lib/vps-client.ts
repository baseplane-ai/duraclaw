import type { GatewayEvent } from './types'

export function parseEvent(data: string | ArrayBuffer): GatewayEvent {
  const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
  return JSON.parse(raw) as GatewayEvent
}
