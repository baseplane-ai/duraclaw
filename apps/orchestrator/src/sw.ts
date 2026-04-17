/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope

import { precacheAndRoute } from 'workbox-precaching'

precacheAndRoute(self.__WB_MANIFEST)

// Wait for user to trigger update — no auto-skipWaiting on install.
// The app sends SKIP_WAITING when the user clicks "Reload" in the update toast.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

// Push event handler stub — implemented in Phase 3a
self.addEventListener('push', (event) => {
  const data = event.data?.json()
  if (!data) return
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      tag: data.tag,
      data: { url: data.url, sessionId: data.sessionId, actionToken: data.actionToken },
      actions: data.actions ?? [],
    } as NotificationOptions),
  )
})

/**
 * Route a notification tap to the target URL.
 *
 * Mobile PWA quirks we have to work around:
 *   - `clients.openWindow(url)` focuses an existing window without navigating it
 *     (so tapping a notification refocuses the app on whatever page it was on).
 *   - `WindowClient.navigate(url)` is unreliable on Android Chrome standalone
 *     PWAs: it frequently resolves to `null` or silently no-ops even when the
 *     client is controlled and the URL is in scope. Relying on its return value
 *     (as an earlier version of this helper did) leaves the app focused on the
 *     wrong page.
 *
 * Instead, if a client exists, postMessage the target URL to it and let the SPA
 * handle routing via TanStack Router (see useSwNavigate hook). Cold-start with
 * no existing client falls back to openWindow, which DOES navigate when opening
 * a brand-new window.
 */
async function openOrFocus(target: string): Promise<void> {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of all) {
    const win = client as WindowClient
    try {
      win.postMessage({ type: 'SW_NAVIGATE', url: target })
      await win.focus()
      return
    } catch {
      // Client may be gone or cross-origin — try the next one.
    }
  }
  await self.clients.openWindow(target)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { url, sessionId, actionToken } = event.notification.data ?? {}

  if ((event.action === 'approve' || event.action === 'deny') && sessionId && actionToken) {
    event.waitUntil(
      fetch(`/api/sessions/${sessionId}/tool-approval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${actionToken}`,
        },
        body: JSON.stringify({ approved: event.action === 'approve' }),
      }),
    )
    return
  }

  // New Session action — open dashboard without session context
  if (event.action === 'new-session') {
    event.waitUntil(openOrFocus('/'))
    return
  }

  // Open action or default click — open the session URL
  event.waitUntil(openOrFocus(url || '/'))
})
