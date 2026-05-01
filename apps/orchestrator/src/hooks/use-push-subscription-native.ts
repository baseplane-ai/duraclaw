import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl, isExpoNative } from '~/lib/platform'

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
 *
 * Note: the `pushNotificationActionPerformed` (tap-to-deep-link) handler is
 * NOT registered here — it lives in `~/lib/native-push-deep-link` and is
 * installed at boot from `entry-client.tsx`, BEFORE React mounts, so it
 * captures cold-start taps without racing AgentOrchPage's cold-start effect.
 */
export function usePushSubscriptionNative() {
  const [permission, setPermission] = useState<Permission>('prompt')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const autoSubscribeAttempted = useRef(false)

  useEffect(() => {
    let cleanup: (() => void) | null = null

    // Expo native (Metro): @react-native-firebase/messaging instead of
    // @capacitor/push-notifications. The on-token-refresh listener is
    // the analogue of Capacitor's `registration` event; missing-FCM
    // (no google-services.json) surfaces as a thrown error from
    // getToken(), same fail-soft path as the Capacitor branch.
    if (isExpoNative()) {
      ;(async () => {
        try {
          type MessagingFn = () => {
            onTokenRefresh: (cb: (token: string) => void | Promise<void>) => () => void
            requestPermission: () => Promise<number>
            getToken: () => Promise<string>
          }
          const messagingMod = (await import(
            /* @vite-ignore */ '@react-native-firebase/messaging'
          )) as unknown as MessagingFn | { default: MessagingFn }
          const messaging: MessagingFn =
            (messagingMod as { default?: MessagingFn }).default ?? (messagingMod as MessagingFn)

          // Token refresh listener — fires when FCM rotates the token.
          const refreshUnsub = messaging().onTokenRefresh(async (newToken) => {
            console.info('[push] FCM token refresh, length:', newToken?.length)
            setToken(newToken)
            setIsSubscribed(true)
            await postTokenToServer(newToken)
          })
          cleanup = () => refreshUnsub()

          if (!autoSubscribeAttempted.current) {
            autoSubscribeAttempted.current = true
            // Android 13+ runtime permission. requestPermission returns
            // an authorization status enum (0=notDetermined, 1=denied,
            // 2=authorized, 3=provisional). We treat 2 and 3 as granted.
            const authStatus = await messaging().requestPermission()
            const granted = authStatus === 1 || authStatus === 2
            setPermission(granted ? 'granted' : authStatus === 0 ? 'prompt' : 'denied')
            if (granted) {
              const fcmToken = await messaging().getToken()
              if (fcmToken) {
                setToken(fcmToken)
                setIsSubscribed(true)
                await postTokenToServer(fcmToken)
              }
            }
          }
        } catch (err) {
          // FCM not configured (missing google-services.json) — fail gracefully
          console.warn('[push] expo-native push setup failed:', err)
          setPermission('unsupported')
        }
      })()
      return () => {
        cleanup?.()
      }
    }

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
    if (isExpoNative()) {
      try {
        type MessagingFn = () => {
          requestPermission: () => Promise<number>
          getToken: () => Promise<string>
        }
        const messagingMod = (await import(
          /* @vite-ignore */ '@react-native-firebase/messaging'
        )) as unknown as MessagingFn | { default: MessagingFn }
        const messaging: MessagingFn =
          (messagingMod as { default?: MessagingFn }).default ?? (messagingMod as MessagingFn)
        const authStatus = await messaging().requestPermission()
        const granted = authStatus === 1 || authStatus === 2
        setPermission(granted ? 'granted' : 'denied')
        if (!granted) return false
        const fcmToken = await messaging().getToken()
        if (fcmToken) {
          setToken(fcmToken)
          setIsSubscribed(true)
          await postTokenToServer(fcmToken)
        }
        return true
      } catch (err) {
        console.warn('[push] expo-native registration failed:', err)
        setPermission('unsupported')
        return false
      }
    }
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
