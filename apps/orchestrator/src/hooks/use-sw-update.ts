/**
 * useSwUpdate — Service worker update detection + auto-reload.
 *
 * Combines two staleness signals:
 * 1. Build hash polling (fast — detects new deploys in ~30s)
 * 2. SW update detection (fallback — browser's native update check)
 *
 * When either fires, triggers SW update + reload.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBuildHash } from './use-build-hash'

const SW_POLL_INTERVAL = 60_000 // 1 minute fallback

export function useSwUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const { stale: buildStale } = useBuildHash()

  // When build hash detects staleness, force an immediate SW update check
  useEffect(() => {
    if (!buildStale) return
    const reg = registrationRef.current
    if (reg) {
      reg
        .update()
        .then(() => {
          // If there's already a waiting worker, signal it
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' })
          }
        })
        .catch(() => {})
    }
    setUpdateAvailable(true)
  }, [buildStale])

  const applyUpdate = useCallback(() => {
    const waiting = registrationRef.current?.waiting
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' })
    } else {
      // No waiting SW — just reload to pick up new assets
      window.location.reload()
    }
    // controllerchange listener below handles the reload when SW takes over
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    let interval: ReturnType<typeof setInterval> | null = null

    navigator.serviceWorker.ready.then((registration) => {
      registrationRef.current = registration

      // Check if there's already a waiting worker
      if (registration.waiting) {
        setUpdateAvailable(true)
      }

      // Listen for new workers entering waiting state
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            setUpdateAvailable(true)
          }
        })
      })

      // Poll for SW updates as fallback (slower than build hash, but catches edge cases)
      interval = setInterval(() => {
        registration.update().catch(() => {})
      }, SW_POLL_INTERVAL)
    })

    // When a new SW takes control, reload to use fresh assets
    const onControllerChange = () => {
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    return () => {
      if (interval) clearInterval(interval)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  return { updateAvailable, applyUpdate }
}
