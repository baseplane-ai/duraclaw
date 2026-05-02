import { useCallback, useEffect, useState } from 'react'
import { apiUrl, isNative } from '~/lib/platform'
import { usePushSubscriptionNative } from './use-push-subscription-native'

type PushPermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported'

export function usePushSubscriptionWeb() {
  const [permission, setPermission] = useState<PushPermissionState>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
    return Notification.permission as PushPermissionState
  })
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Check if already subscribed
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription()
      setIsSubscribed(!!sub)
    })
  }, [])

  const subscribe = useCallback(async () => {
    setError(null)
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setError('Push notifications are not supported in this browser')
      return false
    }

    let result: NotificationPermission
    try {
      result = await Notification.requestPermission()
    } catch (err) {
      console.error('[push] requestPermission failed:', err)
      setError('Unable to prompt for notification permission')
      return false
    }
    setPermission(result as PushPermissionState)
    if (result !== 'granted') {
      setError(
        result === 'denied'
          ? 'Notifications blocked — enable in browser settings'
          : 'Notification permission was not granted',
      )
      return false
    }

    try {
      // Fetch VAPID public key
      const resp = await fetch(apiUrl('/api/push/vapid-key'))
      if (!resp.ok) {
        const msg = `VAPID key fetch failed (${resp.status})`
        console.error('[push] subscribe failed:', msg)
        setError(msg)
        return false
      }
      const { publicKey } = (await resp.json()) as { publicKey: string }

      // Convert base64url to Uint8Array
      const urlBase64ToUint8Array = (base64String: string) => {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
        const rawData = atob(base64)
        return Uint8Array.from(rawData, (char) => char.charCodeAt(0))
      }

      const reg = await navigator.serviceWorker.ready
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })

      const subJson = subscription.toJSON()
      const postResp = await fetch(apiUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        }),
      })
      if (!postResp.ok) {
        const msg = `Subscribe POST failed (${postResp.status})`
        console.error('[push] subscribe failed:', msg)
        setError(msg)
        return false
      }

      setIsSubscribed(true)
      return true
    } catch (err) {
      console.error('[push] subscribe failed:', err)
      setError(err instanceof Error ? err.message : 'Subscribe failed')
      return false
    }
  }, [])

  const unsubscribe = useCallback(async () => {
    setError(null)
    if (!('serviceWorker' in navigator)) return

    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (!sub) return

      const endpoint = sub.endpoint
      await sub.unsubscribe()

      await fetch(apiUrl('/api/push/unsubscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      })

      setIsSubscribed(false)
    } catch (err) {
      console.error('[push] unsubscribe failed:', err)
      setError(err instanceof Error ? err.message : 'Unsubscribe failed')
    }
  }, [])

  return { permission, isSubscribed, subscribe, unsubscribe, error }
}

/**
 * Platform-aware push subscription. Both implementations return the same
 * shape. `isNative()` is a build-time constant after Vite dead-code-
 * elimination, so the picked hook is effectively static per build — we
 * resolve once at module load to keep React's rules-of-hooks happy
 * (single call site, stable identity per build). The native hook still
 * dynamic-imports `@capacitor/push-notifications` internally so it's
 * tree-shaken from the web bundle.
 */
const platformHook = isNative() ? usePushSubscriptionNative : usePushSubscriptionWeb

export function usePushSubscription() {
  return platformHook()
}
