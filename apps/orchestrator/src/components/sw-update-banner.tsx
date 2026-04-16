/**
 * SwUpdateBanner — Shows when a new version is available.
 * Auto-applies after 2 seconds, or immediately on click.
 *
 * Powered by build hash polling (detects new deploys in ~30s)
 * with SW update detection as fallback.
 */

import { RefreshCwIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useSwUpdate } from '~/hooks/use-sw-update'

export function SwUpdateBanner() {
  const { updateAvailable, applyUpdate } = useSwUpdate()

  // Auto-apply after 2s so the user doesn't have to interact
  useEffect(() => {
    if (!updateAvailable) return
    const timer = setTimeout(applyUpdate, 2000)
    return () => clearTimeout(timer)
  }, [updateAvailable, applyUpdate])

  if (!updateAvailable) return null

  return (
    <button
      type="button"
      onClick={applyUpdate}
      className="fixed top-2 right-2 z-[100] flex items-center gap-2 rounded-lg border bg-primary px-3 py-2 text-primary-foreground text-sm shadow-lg animate-in fade-in slide-in-from-top-2"
    >
      <RefreshCwIcon className="size-4 animate-spin" />
      Updating to latest version…
    </button>
  )
}
