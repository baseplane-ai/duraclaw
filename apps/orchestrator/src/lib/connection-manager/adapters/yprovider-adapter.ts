import type YProvider from 'y-partyserver/provider'
import type { ConnectionEventListener, ManagedConnection } from '../types'

type StatusPayload = { status?: string } | undefined

/**
 * Wrap a y-partyserver `YProvider` in the substrate-agnostic
 * `ManagedConnection` shape. YProvider is an `lib0/observable`, not a
 * DOM EventTarget — the adapter translates between the two:
 *
 *   addEventListener('open', fn)    → provider.on('status', ...connected)
 *   addEventListener('close', fn)   → provider.on('status', ...disconnected)
 *   addEventListener('error', fn)   → no-op (no separate error channel)
 *   addEventListener('message', fn) → provider.on('sync', ...)
 *
 * `lastSeenTs` is bumped on every `sync` and every awareness update —
 * both are live-connection signals.
 */
export function createYProviderAdapter(provider: YProvider, id: string): ManagedConnection {
  // Track the user-provided listener → (observable event, handler) so
  // removeEventListener can undo the translated subscription.
  type Entry = { event: string; handler: (...args: unknown[]) => void }
  const registered = new Map<ConnectionEventListener, Entry>()

  const adapter: ManagedConnection = {
    id,
    kind: 'yprovider',
    get readyState() {
      if (provider.wsconnected) return WebSocket.OPEN
      if (provider.wsconnecting) return WebSocket.CONNECTING
      return WebSocket.CLOSED
    },
    lastSeenTs: Date.now(),
    reconnect() {
      // YProvider exposes no public reconnect; disconnect+connect is
      // idempotent and matches y-partyserver's own drop-and-retry path.
      try {
        provider.disconnect()
      } catch (err) {
        console.warn('[cm-yprovider] disconnect threw', err)
      }
      try {
        void provider.connect()
      } catch (err) {
        console.warn('[cm-yprovider] connect threw', err)
      }
    },
    close() {
      try {
        provider.disconnect()
      } catch (err) {
        console.warn('[cm-yprovider] disconnect threw', err)
      }
    },
    addEventListener(event, fn) {
      if (event === 'error') {
        // No-op: YProvider has no separate error event channel. Still
        // recorded so a later removeEventListener is symmetric.
        registered.set(fn, { event: 'error-noop', handler: () => {} })
        return
      }
      if (event === 'open') {
        const handler = (payload: StatusPayload) => {
          if (payload?.status === 'connected') fn(new Event('open'))
        }
        provider.on('status', handler as never)
        registered.set(fn, { event: 'status', handler: handler as never })
        return
      }
      if (event === 'close') {
        const handler = (payload: StatusPayload) => {
          if (payload?.status === 'disconnected') fn(new Event('close'))
        }
        provider.on('status', handler as never)
        registered.set(fn, { event: 'status', handler: handler as never })
        return
      }
      if (event === 'message') {
        const handler = (isSynced: boolean) => {
          fn(new MessageEvent('message', { data: { synced: isSynced } }))
        }
        provider.on('sync', handler as never)
        registered.set(fn, { event: 'sync', handler: handler as never })
        return
      }
    },
    removeEventListener(_event, fn) {
      const entry = registered.get(fn)
      if (!entry) return
      registered.delete(fn)
      if (entry.event === 'error-noop') return
      provider.off(entry.event, entry.handler as never)
    },
  }

  const bump = () => {
    adapter.lastSeenTs = Date.now()
  }
  provider.on('sync', bump as never)
  provider.awareness.on('update', bump)

  return adapter
}
