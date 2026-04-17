import { useEffect, useRef } from 'react'

/**
 * Listen for navigation commands from the service worker and perform a
 * full-page load to the target URL.
 *
 * The service worker sends SW_NAVIGATE when a push notification is tapped
 * while the PWA is already running. We listen on THREE channels for maximum
 * reliability across mobile browser quirks:
 *
 * 1. **BroadcastChannel('sw-nav')** — fast path. Independent API, no setup
 *    requirements, doesn't care about controlled/uncontrolled clients, no
 *    startMessages().
 *
 * 2. **navigator.serviceWorker 'message' event** — fast path fallback via
 *    client.postMessage(). Requires startMessages() to enable the message
 *    queue.
 *
 * 3. **Cache Storage `sw-pending-nav` drain on visibilitychange** — durable
 *    path. The SW writes the target URL to a well-known cache entry on
 *    every notificationclick. When the PWA becomes visible (which always
 *    happens after a notification tap), we read and consume the entry. This
 *    survives SW→client messaging failures that Android Chrome standalone
 *    PWAs exhibit when resumed from freeze-dry, where both BroadcastChannel
 *    and postMessage silently drop messages.
 *
 * Whichever fires first wins; the others are deduplicated by a short guard.
 *
 * We deliberately use `window.location.assign()` rather than TanStack
 * Router's soft navigate(). On Android Chrome standalone PWAs resumed from
 * freeze-dry via notification tap, soft navigate frequently no-ops — the
 * URL update is swallowed during the visibility transition. A full page
 * load always works and costs nothing perceptible on this path (user is
 * arriving from outside the app anyway).
 */
export function useSwNavigate() {
  // Dedupe guard: skip duplicate navigations within 1500ms. Bumped up from
  // 500ms because the visibilitychange fallback can fire up to ~1s after
  // the SW messaging fast path.
  const lastNavRef = useRef<{ url: string; time: number } | null>(null)

  useEffect(() => {
    function handleNavigate(url: string, source: string) {
      // Dedupe: if we navigated to the same URL within 1500ms, skip.
      const now = Date.now()
      const last = lastNavRef.current
      if (last && last.url === url && now - last.time < 1500) {
        console.log(`[sw:nav] dedupe skip (${source}) url=${url}`)
        return
      }
      lastNavRef.current = { url, time: now }

      let parsed: URL
      try {
        parsed = new URL(url, window.location.origin)
      } catch (err) {
        console.log(`[sw:nav] URL parse failed (${source}) — ignoring`, url, err)
        return
      }
      if (parsed.origin !== window.location.origin) {
        console.log(`[sw:nav] cross-origin rejected (${source}): ${parsed.origin}`)
        return
      }

      console.log(
        `[sw:nav] navigating (${source}) → ${parsed.pathname}${parsed.search} (full page load)`,
      )
      // Full-page navigation — reliable across freeze-dried PWA resumes where
      // soft-navs get swallowed. App will remount and read ?session=X from
      // the URL on init.
      window.location.assign(parsed.toString())
    }

    // --- Channel 1: BroadcastChannel (primary) ---
    let bc: BroadcastChannel | null = null
    try {
      bc = new BroadcastChannel('sw-nav')
      bc.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; url?: string } | undefined
        console.log('[sw:nav] BroadcastChannel message received', data)
        if (data?.type === 'SW_NAVIGATE' && typeof data.url === 'string') {
          handleNavigate(data.url, 'broadcast')
        }
      }
      console.log('[sw:nav] BroadcastChannel listener installed')
    } catch (err) {
      console.log('[sw:nav] BroadcastChannel unavailable — relying on postMessage only', err)
    }

    // --- Channel 2: SW postMessage (fallback) ---
    let swHandler: ((event: MessageEvent) => void) | null = null
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      swHandler = (event: MessageEvent) => {
        const data = event.data as { type?: string; url?: string } | undefined
        if (data?.type === 'SW_NAVIGATE' && typeof data.url === 'string') {
          console.log('[sw:nav] postMessage received', data)
          handleNavigate(data.url, 'postMessage')
        }
      }
      navigator.serviceWorker.addEventListener('message', swHandler)
      // Enable the SW message queue (required for addEventListener to fire).
      if (navigator.serviceWorker.startMessages) {
        navigator.serviceWorker.startMessages()
      }
      console.log('[sw:nav] postMessage listener installed (with startMessages)')
    }

    // --- Channel 3: Cache Storage drain on visibilitychange (durable) ---
    // This is the channel that saves us on Android Chrome standalone PWAs
    // where SW→client messaging silently drops during freeze-dry resume.
    // The SW writes the target URL to Cache Storage on every notificationclick;
    // when the PWA becomes visible we read, navigate, and clear.
    async function drainPendingNav(source: string) {
      if (typeof caches === 'undefined') return
      try {
        const cache = await caches.open('sw-pending-nav')
        const resp = await cache.match('/pending-nav')
        if (!resp) return
        const url = await resp.text()
        if (!url) {
          await cache.delete('/pending-nav')
          return
        }
        console.log(`[sw:nav] drained Cache Storage pending-nav (${source}) url=${url}`)
        await cache.delete('/pending-nav')
        handleNavigate(url, `cache:${source}`)
      } catch (err) {
        console.log(`[sw:nav] Cache Storage drain failed (${source})`, err)
      }
    }

    // Drain on mount (covers cold-open from notification).
    drainPendingNav('mount')

    // Drain on visibilitychange when the document becomes visible (covers
    // warm-open from notification tap).
    const visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        drainPendingNav('visibilitychange')
      }
    }
    document.addEventListener('visibilitychange', visibilityHandler)
    // Also drain on window focus as a belt — some Android Chrome builds
    // don't fire visibilitychange reliably on PWA resume.
    const focusHandler = () => drainPendingNav('focus')
    window.addEventListener('focus', focusHandler)

    return () => {
      console.log('[sw:nav] cleaning up listeners')
      if (bc) {
        bc.close()
        bc = null
      }
      if (swHandler && navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener('message', swHandler)
      }
      document.removeEventListener('visibilitychange', visibilityHandler)
      window.removeEventListener('focus', focusHandler)
    }
  }, [])
}
