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
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return

    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | undefined
      if (!data || data.type !== 'SW_NAVIGATE' || typeof data.url !== 'string') return

      let parsed: URL
      try {
        parsed = new URL(data.url, window.location.origin)
      } catch {
        return
      }
      // Ignore cross-origin — shouldn't happen but guard anyway.
      if (parsed.origin !== window.location.origin) return

      const search: Record<string, string> = {}
      parsed.searchParams.forEach((value, key) => {
        search[key] = value
      })

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
    return () => navigator.serviceWorker.removeEventListener('message', handler)
  }, [navigate])
}
