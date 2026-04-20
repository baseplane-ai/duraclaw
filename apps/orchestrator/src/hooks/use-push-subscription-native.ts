import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from '~/lib/platform'

type Permission = 'prompt' | 'granted' | 'denied' | 'unsupported'

const MAX_RETRY = 3
const RETRY_DELAY_MS = 2000

/**
 * POST the FCM token to the server with retry logic.
 * Returns true if the server responded 2xx.
 */
async function postTokenToServer(fcmToken: string): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const resp = await fetch(apiUrl('/api/push/fcm-subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fcmToken, platform: 'android' }),
      })
      if (resp.ok) {
        console.info('[push] FCM token registered on server')
        return true
      }
      console.warn(
        `[push] fcm-subscribe responded ${resp.status} (attempt ${attempt + 1}/${MAX_RETRY})`,
      )
    } catch (err) {
      console.warn(`[push] fcm-subscribe network error (attempt ${attempt + 1}/${MAX_RETRY}):`, err)
    }
    if (attempt < MAX_RETRY - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)))
    }
  }
  console.error('[push] FCM token registration failed after all retries')
  return false
}

/**
 * Capacitor-native push subscription. Wraps @capacitor/push-notifications:
 * request permission → register → POST FCM token to server. Auto-subscribes
 * on mount when permission is already granted (Android 13+ runtime permission
 * is pre-granted if the user accepted the OS prompt). Listens for registration
 * events so token rotation is captured automatically.
 */
export function usePushSubscriptionNative() {
  const [permission, setPermission] = useState<Permission>('prompt')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const autoSubscribeAttempted = useRef(false)

  useEffect(() => {
    let cleanup: (() => void) | null = null
    ;(async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications')

        const regHandle = await PushNotifications.addListener('registration', async (t) => {
          console.info('[push] registration event received, token length:', t.value?.length)
          setToken(t.value)
          setIsSubscribed(true)
          await postTokenToServer(t.value)
        })

        const errHandle = await PushNotifications.addListener('registrationError', (err) => {
          console.error('[push] registrationError:', JSON.stringify(err))
          setIsSubscribed(false)
        })

        cleanup = () => {
          regHandle.remove()
          errHandle.remove()
        }

        // Auto-subscribe on native: if permission is already granted, register
        // immediately without waiting for user interaction. This is safe on
        // Android because POST_NOTIFICATIONS is a runtime permission that the
        // OS prompts for — if we reach here without 'granted', the OS prompt
        // will show on requestPermissions().
        if (!autoSubscribeAttempted.current) {
          autoSubscribeAttempted.current = true
          const status = await PushNotifications.checkPermissions()
          setPermission(status.receive as Permission)
          if (status.receive === 'granted') {
            console.info('[push] permission already granted, auto-registering')
            await PushNotifications.register()
          }
        }
      } catch (err) {
        // FCM not configured — listeners can't be added, skip silently
        console.warn('[push] native push setup failed:', err)
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
