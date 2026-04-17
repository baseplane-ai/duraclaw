/**
 * useSwUpdate — Detects new deploys, lets the user choose when to reload.
 *
 * Detection: build hash polling (~30s) triggers `reg.update()`, which
 * installs the new SW into "waiting" state. No auto-skipWaiting.
 *
 * Activation: user clicks "Reload" → SKIP_WAITING message → new SW
 * activates → controllerchange → page reloads.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBuildHash } from './use-build-hash'

export function useSwUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const { stale: buildStale } = useBuildHash()

  // Grab SW registration and watch for waiting workers
  useEffect(() => {
    if (!navigator.serviceWorker) return

    navigator.serviceWorker.ready.then((registration) => {
      registrationRef.current = registration

      // Already a waiting worker (e.g. installed while page was idle)
      if (registration.waiting) {
        setUpdateAvailable(true)
      }

      // New SW installed → enters waiting state
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            setUpdateAvailable(true)
          }
        })
      })
    })

    // When the new SW takes control, reload to use fresh assets
    const onControllerChange = () => window.location.reload()
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  // Build hash detects new deploy → trigger SW update check immediately
  useEffect(() => {
    if (!buildStale) return
    registrationRef.current?.update().catch(() => {})
  }, [buildStale])

  // User-initiated: tell waiting SW to activate
  const applyUpdate = useCallback(() => {
    const waiting = registrationRef.current?.waiting
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' })
    } else {
      // Edge case: no waiting SW (maybe it already activated) — just reload
      window.location.reload()
    }
  }, [])

  return { updateAvailable, applyUpdate }
}
