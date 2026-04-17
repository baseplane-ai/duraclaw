/**
 * SwUpdateBanner — Shows a persistent toast when a new version is available.
 * User clicks "Reload" to hard-refresh when ready.
 */

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useSwUpdate } from '~/hooks/use-sw-update'

export function SwUpdateBanner() {
  const { updateAvailable } = useSwUpdate()
  const toastShown = useRef(false)

  useEffect(() => {
    if (!updateAvailable || toastShown.current) return
    toastShown.current = true

    toast('New version available', {
      description: 'Reload to get the latest updates.',
      duration: Infinity,
      action: {
        label: 'Reload',
        onClick: () => window.location.reload(),
      },
    })
  }, [updateAvailable])

  return null
}
