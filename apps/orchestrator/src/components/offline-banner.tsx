import { useEffect, useState } from 'react'
import { useConnectionStatus } from '~/lib/connection-manager/useConnectionStatus'

const SHOW_DEBOUNCE_MS = 1000

/**
 * GH#42 — OfflineBanner driven by the unified `useConnectionStatus`
 * signal from the connection-manager registry (replaces the prior
 * `navigator.onLine` poll). Debounces the SHOW transition by 1 s so a
 * sub-second reconnect blip never flashes the banner; hides
 * immediately on recovery.
 */
export function OfflineBanner() {
  const { isOnline } = useConnectionStatus()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isOnline) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => {
      setVisible(true)
    }, SHOW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [isOnline])

  if (!visible) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 bg-warning px-4 py-2 text-sm font-medium text-warning-foreground">
      <span>Reconnecting…</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded bg-warning-foreground/10 px-2 py-0.5 text-xs font-semibold hover:bg-warning-foreground/20"
      >
        Retry
      </button>
    </div>
  )
}
