import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

/**
 * Listen for navigation commands from the service worker and route through
 * TanStack Router.
 *
 * The service worker sends SW_NAVIGATE when a push notification is tapped
 * while the PWA is already running. We listen on TWO channels for maximum
 * reliability across mobile browser quirks:
 *
 * 1. **BroadcastChannel('sw-nav')** — independent API, no setup requirements,
 *    doesn't care about controlled/uncontrolled clients, no startMessages().
 *    This is the primary channel.
 *
 * 2. **navigator.serviceWorker 'message' event** — belt-and-suspenders
 *    fallback via client.postMessage(). Requires startMessages() to enable
 *    the message queue.
 *
 * Whichever fires first wins; the second is deduplicated by a short guard.
 */
export function useSwNavigate() {
  const navigate = useNavigate()
  // Dedupe guard: skip duplicate navigations within 500ms
  const lastNavRef = useRef<{ url: string; time: number } | null>(null)

  useEffect(() => {
    function handleNavigate(url: string, source: string) {
      // Dedupe: if we navigated to the same URL within 500ms, skip.
      const now = Date.now()
      const last = lastNavRef.current
      if (last && last.url === url && now - last.time < 500) {
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

      const search: Record<string, string> = {}
      parsed.searchParams.forEach((value, key) => {
        search[key] = value
      })

      console.log(
        `[sw:nav] navigating (${source}) → pathname=${parsed.pathname} search=${JSON.stringify(search)}`,
      )
      navigate({
        to: parsed.pathname as '/',
        search: search as { session?: string },
        replace: false,
      })
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

    return () => {
      console.log('[sw:nav] cleaning up listeners')
      if (bc) {
        bc.close()
        bc = null
      }
      if (swHandler && navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener('message', swHandler)
      }
    }
  }, [navigate])
}
