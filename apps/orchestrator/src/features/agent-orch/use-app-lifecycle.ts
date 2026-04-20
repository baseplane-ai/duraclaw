/**
 * Capacitor app-lifecycle hook for B6: gracefully close the WS when the
 * app is backgrounded for >5s (Android kills background WS anyway, do it
 * proactively so the DO sees a clean disconnect instead of half-open
 * frames), and trigger a getMessages hydration RPC on foreground so any
 * messages that landed during the background window are caught up.
 *
 * No-op on web (isNative() === false short-circuits before any dynamic
 * import) — the @capacitor/app plugin is never loaded in the web bundle.
 */
import { useEffect, useRef } from 'react'
import { isNative } from '~/lib/platform'

type Connection = {
  readyState: number
  reconnect?: () => void
  close?: () => void
}

export function useAppLifecycle(opts: { connection: Connection; hydrate: () => void }) {
  const { connection, hydrate } = opts
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    let removeListener: (() => void) | null = null

    ;(async () => {
      const { App } = await import('@capacitor/app')
      if (cancelled) return
      const handle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          // Foreground: cancel pending close, trigger hydrate. Agents-SDK
          // partysocket auto-reconnects when WS is closed/closing, so we
          // don't need to manually call reconnect — just kick the
          // getMessages RPC so we replay anything missed during the gap.
          if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
          }
          hydrate()
          return
        }
        // Background: 5s grace period before closing. If the user comes
        // back within 5s the timer is cancelled in the foreground branch.
        closeTimerRef.current = setTimeout(() => {
          try {
            connection.close?.()
          } catch {
            // ignore — best-effort
          }
          closeTimerRef.current = null
        }, 5000)
      })
      removeListener = () => {
        handle.remove()
      }
    })()

    return () => {
      cancelled = true
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      removeListener?.()
    }
  }, [connection, hydrate])
}
