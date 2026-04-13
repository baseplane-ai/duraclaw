/**
 * SwUpdateBanner — Shows when a new version is available.
 * Auto-applies after 3 seconds, or immediately on click.
 */

import { RefreshCwIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useSwUpdate } from '~/hooks/use-sw-update'

export function SwUpdateBanner() {
  const { updateAvailable, applyUpdate } = useSwUpdate()

  // Auto-apply after 3s so the user doesn't have to interact
  useEffect(() => {
    if (!updateAvailable) return
    const timer = setTimeout(applyUpdate, 3000)
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
      New version available — updating...
    </button>
  )
}
