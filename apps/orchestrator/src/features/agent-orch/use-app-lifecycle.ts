/**
 * Capacitor app-lifecycle hook: on foreground (and on network reconnect),
 * force both the per-session WS (`reconnect`) and the singleton user-stream
 * WS (`reconnectUserStreamNow`) to reconnect, then fire a `hydrate()` RPC so
 * any messages that landed while backgrounded are replayed.
 *
 * Why unconditional reconnect? Android aggressively suspends the WebView JS
 * runtime when backgrounded. While frozen, the server may close its half of
 * the socket (or the carrier may NAT-rebind, or Wi-Fi may hand off) without
 * a `close` event reaching JS. On resume, `readyState` still reads OPEN but
 * the underlying TCP is dead — any send disappears until the kernel's TCP
 * keepalive times out (30–120s on Android). Forcing a reconnect on every
 * resume collapses that latency to ~immediate at the cost of one cycle on
 * brief background flips — an acceptable trade-off on mobile.
 *
 * Network-change: `@capacitor/network`'s `networkStatusChange` fires on
 * Wi-Fi ↔ cell handoff and on connect/disconnect transitions. When we
 * regain connectivity (`connected === true`) we fire the same kick.
 *
 * No-op on web (isNative() === false short-circuits before any dynamic
 * import) — the @capacitor/* plugins are never loaded in the web bundle.
 */
import { useEffect } from 'react'
import { reconnectUserStreamNow } from '~/hooks/use-user-stream'
import { isNative } from '~/lib/platform'

export function useAppLifecycle(opts: { hydrate: () => void; reconnect?: () => void }) {
  const { hydrate, reconnect } = opts

  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    const removeListeners: Array<() => void> = []

    const kick = () => {
      // Per-session WS first (owns the active turn stream), then the
      // singleton user-stream WS (synced collections). Wrap each call so a
      // throw from one doesn't starve the others or the hydrate.
      try {
        reconnect?.()
      } catch (err) {
        console.warn('[app-lifecycle] per-session reconnect threw', err)
      }
      try {
        reconnectUserStreamNow()
      } catch (err) {
        console.warn('[app-lifecycle] user-stream reconnect threw', err)
      }
      try {
        hydrate()
      } catch (err) {
        console.warn('[app-lifecycle] hydrate threw', err)
      }
    }

    ;(async () => {
      const [{ App }, { Network }] = await Promise.all([
        import('@capacitor/app'),
        import('@capacitor/network'),
      ])
      if (cancelled) return

      const appHandle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) kick()
      })
      if (cancelled) {
        appHandle.remove()
        return
      }
      removeListeners.push(() => {
        appHandle.remove()
      })

      const netHandle = await Network.addListener(
        'networkStatusChange',
        ({ connected }: { connected: boolean }) => {
          if (connected) kick()
        },
      )
      if (cancelled) {
        netHandle.remove()
        return
      }
      removeListeners.push(() => {
        netHandle.remove()
      })
    })()

    return () => {
      cancelled = true
      for (const remove of removeListeners) {
        try {
          remove()
        } catch {
          // ignore
        }
      }
    }
  }, [hydrate, reconnect])
}
