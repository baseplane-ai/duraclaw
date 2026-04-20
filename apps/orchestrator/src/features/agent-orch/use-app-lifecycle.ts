/**
 * Capacitor app-lifecycle hook: on foreground, fire a getMessages
 * hydration RPC so any messages that landed while backgrounded are
 * replayed. The WS itself is left alone — if Android killed it in the
 * background, partysocket sees an abnormal close and auto-reconnects;
 * if it survived, we keep the live socket and avoid reconnect churn.
 *
 * No-op on web (isNative() === false short-circuits before any dynamic
 * import) — the @capacitor/app plugin is never loaded in the web bundle.
 */
import { useEffect } from 'react'
import { isNative } from '~/lib/platform'

export function useAppLifecycle(opts: { hydrate: () => void }) {
  const { hydrate } = opts

  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    let removeListener: (() => void) | null = null

    ;(async () => {
      const { App } = await import('@capacitor/app')
      if (cancelled) return
      const handle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) hydrate()
      })
      removeListener = () => {
        handle.remove()
      }
    })()

    return () => {
      cancelled = true
      removeListener?.()
    }
  }, [hydrate])
}
