/**
 * useSwUpdate — Service worker update detection + auto-reload.
 *
 * Polls for SW updates every 60s. When a new SW is installed and
 * waiting, triggers skipWaiting + reload so the user gets the
 * latest version without manual cache clearing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const UPDATE_CHECK_INTERVAL = 60_000 // 1 minute

export function useSwUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)

  const applyUpdate = useCallback(() => {
    const waiting = registrationRef.current?.waiting
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' })
    }
    // controllerchange listener below handles the reload
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
            // New SW installed while old one is still controlling — update available
            setUpdateAvailable(true)
          }
        })
      })

      // Poll for updates
      interval = setInterval(() => {
        registration.update().catch(() => {})
      }, UPDATE_CHECK_INTERVAL)
    })

    // When a new SW takes control, reload the page to use fresh assets
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
