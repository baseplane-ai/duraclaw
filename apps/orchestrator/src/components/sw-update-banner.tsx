/**
 * SwUpdateBanner — Non-intrusive banner when a new version is available.
 * User clicks to reload when ready — no auto-refresh.
 */

import { RefreshCwIcon } from 'lucide-react'
import { useSwUpdate } from '~/hooks/use-sw-update'

export function SwUpdateBanner() {
  const { updateAvailable, applyUpdate } = useSwUpdate()

  if (!updateAvailable) return null

  return (
    <button
      type="button"
      onClick={applyUpdate}
      className="fixed top-2 right-2 z-[100] flex items-center gap-2 rounded-lg border bg-primary px-3 py-2 text-primary-foreground text-sm shadow-lg animate-in fade-in slide-in-from-top-2"
    >
      <RefreshCwIcon className="size-4" />
      New version available — click to reload
    </button>
  )
}
