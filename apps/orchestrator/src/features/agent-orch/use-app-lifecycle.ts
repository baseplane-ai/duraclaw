/**
 * App-lifecycle hook: on the page becoming visible / focused (and on
 * network reconnect on native), force both the per-session WS
 * (`reconnect`) and the singleton user-stream WS
 * (`reconnectUserStreamNow`) to reconnect, then fire a `hydrate()` RPC so
 * any messages that landed while backgrounded are replayed.
 *
 * Why unconditional reconnect? Both browsers and Android can leave a
 * zombie WebSocket in `readyState === OPEN` while the underlying TCP is
 * dead — the tab was frozen (Chrome hidden-tab throttle), the laptop
 * suspended, Wi-Fi slept, the carrier NAT-rebound, or Android froze the
 * WebView's JS runtime. In every case, no `close` event reaches JS, so
 * PartySocket's internal reconnect backoff never fires. Any `send`
 * disappears until the kernel's TCP keepalive times out (30–120s).
 * Forcing a reconnect on every visibility/focus transition collapses
 * that latency to ~immediate at the cost of one cycle on brief flips.
 *
 * Trigger sources (deduplicated by a 500ms debounce so a
 * visibilitychange+focus+pageshow burst fires exactly one kick):
 *
 * - DOM `visibilitychange` → only when `visibilityState === 'visible'`.
 *   Fires on tab-switch-in on web, WebView resume on Android. More
 *   reliable than `@capacitor/app` `appStateChange` on native because
 *   it runs synchronously in the JS event loop as the runtime thaws,
 *   no native-bridge round-trip.
 * - `window.focus` → covers "window refocus after switching apps /
 *   unlocking laptop" on web where the tab stays visible and
 *   visibilitychange doesn't fire.
 * - `pageshow` → covers bfcache restore on web and Android cold-resume
 *   edge cases where neither visibilitychange nor focus lands.
 * - `@capacitor/app` `appStateChange` (native only) → belt-and-
 *   suspenders for the Capacitor lifecycle path.
 * - `@capacitor/network` `networkStatusChange` (native only) → fires
 *   on Wi-Fi ↔ cell handoff, which doesn't produce a DOM event.
 *
 * SSR-safe: bails early if `typeof window === 'undefined'`.
 */
import { useEffect } from 'react'
import { reconnectUserStreamNow } from '~/hooks/use-user-stream'
import { isNative } from '~/lib/platform'

const KICK_DEBOUNCE_MS = 500

export function useAppLifecycle(opts: { hydrate: () => void; reconnect?: () => void }) {
  const { hydrate, reconnect } = opts

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    const removeListeners: Array<() => void> = []
    let lastKickAt = 0

    const kick = () => {
      const now = Date.now()
      if (now - lastKickAt < KICK_DEBOUNCE_MS) return
      lastKickAt = now
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

    // ── DOM lifecycle listeners (web + native) ─────────────────────────
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') kick()
    }
    const onFocus = () => kick()
    const onPageShow = () => kick()

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    window.addEventListener('pageshow', onPageShow)
    removeListeners.push(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onPageShow)
    })

    // ── Capacitor lifecycle listeners (native only) ────────────────────
    if (isNative()) {
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
    }

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
