/**
 * GH#42 — `ManagedConnection` is a substrate-agnostic interface for any
 * WebSocket-owning primitive the client uses (PartySocket, y-partyserver
 * `YProvider`, etc.). Adapters live in `./adapters/*`; the registry +
 * manager + hooks consume this shape only.
 *
 * Event callback is `(ev: Event | MessageEvent) => void` by design:
 *   - PartySocket passes DOM-native `Event` / `MessageEvent` through.
 *   - YProvider synthesizes `new Event('open' | 'close')` or
 *     `new MessageEvent('message', { data: ... })` so both adapters
 *     honor the same signature. Consumers that need substrate-specific
 *     data cast at the call site.
 */

export type ConnectionKind = 'partysocket' | 'yprovider'

export type ConnectionEvent = 'open' | 'close' | 'error' | 'message'

export type ConnectionEventListener = (ev: Event | MessageEvent) => void

export interface ManagedConnection {
  readonly id: string
  readonly kind: ConnectionKind
  /**
   * Live passthrough to the underlying socket's `readyState`. For
   * PartySocket this mirrors `ps.readyState` (mutable); for YProvider
   * it is derived from `wsconnected` / `wsconnecting` on every read.
   */
  readonly readyState: number
  /**
   * Timestamp (ms since epoch) of the last live signal — updated on
   * open / message / sync / awareness. The manager gates reconnect on
   * `Date.now() - lastSeenTs > STALE_MS`.
   */
  lastSeenTs: number
  /**
   * Force drop + reconnect. `code` / `reason` are optional diagnostic
   * labels — PartySocket forwards them as the close code/reason, the
   * YProvider adapter ignores them (no public reconnect API).
   */
  reconnect(code?: number, reason?: string): void
  close(code?: number, reason?: string): void
  addEventListener(event: ConnectionEvent, fn: ConnectionEventListener): void
  removeEventListener(event: ConnectionEvent, fn: ConnectionEventListener): void
}
