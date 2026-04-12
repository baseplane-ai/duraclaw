import { useCallback, useEffect, useState } from 'react'

type PushPermissionState = 'prompt' | 'granted' | 'denied' | 'unsupported'

export function usePushSubscription() {
  const [permission, setPermission] = useState<PushPermissionState>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
    return Notification.permission as PushPermissionState
  })
  const [isSubscribed, setIsSubscribed] = useState(false)

  useEffect(() => {
    // Check if already subscribed
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription()
      setIsSubscribed(!!sub)
    })
  }, [])

  const subscribe = useCallback(async () => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return false

    const result = await Notification.requestPermission()
    setPermission(result as PushPermissionState)
    if (result !== 'granted') return false

    try {
      // Fetch VAPID public key
      const resp = await fetch('/api/push/vapid-key')
      if (!resp.ok) return false
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
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        }),
      })

      setIsSubscribed(true)
      return true
    } catch {
      return false
    }
  }, [])

  const unsubscribe = useCallback(async () => {
    if (!('serviceWorker' in navigator)) return

    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return

    const endpoint = sub.endpoint
    await sub.unsubscribe()

    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })

    setIsSubscribed(false)
  }, [])

  return { permission, isSubscribed, subscribe, unsubscribe }
}
