import type PartySocket from 'partysocket'
import type { ConnectionEvent, ConnectionEventListener, ManagedConnection } from '../types'

/**
 * Wrap a `PartySocket` (extends ReconnectingWebSocket) in the
 * substrate-agnostic `ManagedConnection` shape. PartySocket already
 * dispatches DOM `Event` / `MessageEvent` shapes so this adapter is
 * almost pure passthrough — it only tracks `lastSeenTs` and pins an
 * external `id` for the registry.
 */
export function createPartySocketAdapter(ps: PartySocket, id: string): ManagedConnection {
  const adapter: ManagedConnection = {
    id,
    kind: 'partysocket',
    get readyState() {
      return ps.readyState
    },
    lastSeenTs: Date.now(),
    reconnect(code, reason) {
      ps.reconnect(code, reason)
    },
    close(code, reason) {
      ps.close(code, reason)
    },
    addEventListener(event, fn) {
      // PartySocket's TypedEventTarget is stricter than our union —
      // the cast is safe because every event we pipe through
      // (open/close/error/message) exists on both shapes.
      ps.addEventListener(event as Parameters<PartySocket['addEventListener']>[0], fn as never)
    },
    removeEventListener(event, fn) {
      ps.removeEventListener(
        event as Parameters<PartySocket['removeEventListener']>[0],
        fn as never,
      )
    },
  }

  const bump: ConnectionEventListener = () => {
    adapter.lastSeenTs = Date.now()
  }
  const openEvent: ConnectionEvent = 'open'
  const messageEvent: ConnectionEvent = 'message'
  ps.addEventListener(openEvent as Parameters<PartySocket['addEventListener']>[0], bump as never)
  ps.addEventListener(messageEvent as Parameters<PartySocket['addEventListener']>[0], bump as never)

  return adapter
}
