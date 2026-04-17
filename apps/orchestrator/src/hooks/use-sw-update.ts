/**
 * useSwUpdate — Detects new deploys via build hash polling.
 *
 * Detection: build hash polling (~30s) detects new deploy → updateAvailable.
 * Activation: user clicks "Reload" → page reloads with fresh assets.
 *
 * Also registers the service worker and triggers SW update checks
 * when a new build is detected, so the new precache is ready on reload.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useBuildHash } from './use-build-hash'

export function useSwUpdate() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const { stale: buildStale, localHash, remoteHash } = useBuildHash()

  // Register SW on mount
  useEffect(() => {
    if (!navigator.serviceWorker) return

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        registrationRef.current = registration
      })
      .catch(() => {})
  }, [])

  // Build hash detects new deploy → trigger SW update check so precache is ready
  useEffect(() => {
    if (!buildStale) return
    registrationRef.current?.update().catch(() => {})
  }, [buildStale])

  // For settings Force Refresh: try SW activation, fallback to plain reload
  const applyUpdate = useCallback(() => {
    const waiting = registrationRef.current?.waiting
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' })
    }
    // Always reload — don't rely on controllerchange
    window.location.reload()
  }, [])

  return { updateAvailable: buildStale, localHash, remoteHash, applyUpdate }
}
