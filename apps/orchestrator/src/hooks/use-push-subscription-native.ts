import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '~/lib/platform'

type Permission = 'prompt' | 'granted' | 'denied' | 'unsupported'

/**
 * Capacitor-native push subscription. Wraps @capacitor/push-notifications:
 * request permission → register → POST FCM token to server. Listens for
 * registration events so token rotation is captured automatically.
 */
export function usePushSubscriptionNative() {
  const [permission, setPermission] = useState<Permission>('prompt')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    let cleanup: (() => void) | null = null
    ;(async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications')
        const regHandle = await PushNotifications.addListener('registration', async (t) => {
          setToken(t.value)
          setIsSubscribed(true)
          try {
            await fetch(apiUrl('/api/push/fcm-subscribe'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: t.value, platform: 'android' }),
            })
          } catch {
            // best-effort
          }
        })
        const errHandle = await PushNotifications.addListener('registrationError', () => {
          setIsSubscribed(false)
        })
        cleanup = () => {
          regHandle.remove()
          errHandle.remove()
        }
      } catch {
        // FCM not configured — listeners can't be added, skip silently
        setPermission('unsupported')
      }
    })()
    return () => {
      cleanup?.()
    }
  }, [])

  const subscribe = useCallback(async () => {
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications')
      const status = await PushNotifications.requestPermissions()
      setPermission(status.receive as Permission)
      if (status.receive !== 'granted') return false
      await PushNotifications.register()
      return true
    } catch (err) {
      // FCM not configured (missing google-services.json) — fail gracefully
      console.warn('[push] registration failed:', err)
      setPermission('unsupported')
      return false
    }
  }, [])

  const unsubscribe = useCallback(async () => {
    if (!token) return
    try {
      await fetch(apiUrl('/api/push/fcm-unsubscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    } catch {
      // ignore
    }
    setIsSubscribed(false)
    setToken(null)
  }, [token])

  return { permission, isSubscribed, subscribe, unsubscribe }
}
