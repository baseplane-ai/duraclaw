import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

/**
 * Listen for `SW_NAVIGATE` messages from the service worker and route through
 * TanStack Router.
 *
 * The service worker (sw.ts) sends this message when a push notification is
 * tapped while a PWA window already exists. Going through React Router (instead
 * of WindowClient.navigate, which is unreliable on Android Chrome standalone
 * PWAs) lets the URL-sync effect in AgentOrchPage activate/create the matching
 * tab and set selectedSessionId.
 */
export function useSwNavigate() {
  const navigate = useNavigate()

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      console.log('[sw:nav] navigator.serviceWorker unavailable — listener not installed')
      return
    }
    console.log('[sw:nav] installing SW_NAVIGATE listener')

    // CRITICAL: calling addEventListener('message', ...) does NOT enable the
    // ServiceWorkerContainer's client message queue. Without startMessages(),
    // postMessage calls from the service worker are silently buffered forever.
    // https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/startMessages
    if (navigator.serviceWorker.startMessages) {
      navigator.serviceWorker.startMessages()
      console.log('[sw:nav] startMessages() called — message queue enabled')
    }

    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | undefined
      if (!data || data.type !== 'SW_NAVIGATE') {
        // Ignore unrelated SW messages (e.g., SKIP_WAITING handled elsewhere).
        return
      }
      console.log('[sw:nav] received SW_NAVIGATE', data)
      if (typeof data.url !== 'string') {
        console.log('[sw:nav] non-string url — ignoring')
        return
      }

      let parsed: URL
      try {
        parsed = new URL(data.url, window.location.origin)
      } catch (err) {
        console.log('[sw:nav] URL parse failed — ignoring', data.url, err)
        return
      }
      if (parsed.origin !== window.location.origin) {
        console.log(
          `[sw:nav] cross-origin target rejected: ${parsed.origin} vs ${window.location.origin}`,
        )
        return
      }

      const search: Record<string, string> = {}
      parsed.searchParams.forEach((value, key) => {
        search[key] = value
      })

      console.log(
        `[sw:nav] router.navigate → pathname=${parsed.pathname} search=${JSON.stringify(search)}`,
      )
      // TanStack's navigate() types require a typed route for `to` + `search`.
      // The SW only sends same-origin URLs within this app, so cast to the
      // permissive any-pathname shape the router exposes at runtime.
      navigate({
        to: parsed.pathname as '/',
        search: search as { session?: string },
        replace: false,
      })
    }

    navigator.serviceWorker.addEventListener('message', handler)
    return () => {
      console.log('[sw:nav] removing SW_NAVIGATE listener')
      navigator.serviceWorker.removeEventListener('message', handler)
    }
  }, [navigate])
}
