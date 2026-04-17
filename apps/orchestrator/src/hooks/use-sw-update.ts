/**
 * useSwUpdate — Detects new deploys, lets the user choose when to reload.
 *
 * Detection: build hash polling (~30s) detects new deploy.
 * Activation: user clicks "Reload" → page reloads with fresh assets.
 *
 * Also registers the service worker and triggers SW update checks
 * when a new build is detected, so the new precache is ready.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBuildHash } from './use-build-hash'

export function useSwUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const { stale: buildStale } = useBuildHash()

  // Register SW and grab registration
  useEffect(() => {
    if (!navigator.serviceWorker) return

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
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
      .catch(() => {
        // SW registration failed (e.g. dev mode, unsupported) — detection still works via build hash
      })

    // When a new SW takes control, reload to use fresh assets
    const onControllerChange = () => window.location.reload()
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  // Build hash detects new deploy → mark update available + trigger SW update check
  useEffect(() => {
    if (!buildStale) return
    setUpdateAvailable(true)
    registrationRef.current?.update().catch(() => {})
  }, [buildStale])

  // User-initiated: tell waiting SW to activate, or just reload
  const applyUpdate = useCallback(() => {
    const waiting = registrationRef.current?.waiting
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' })
      // controllerchange listener will reload
    } else {
      window.location.reload()
    }
  }, [])

  return { updateAvailable, applyUpdate }
}
