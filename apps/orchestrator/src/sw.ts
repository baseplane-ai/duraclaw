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
 * Navigate an existing PWA window to `target`, or open a new one.
 *
 * On mobile (installed PWA in standalone mode), calling
 * `clients.openWindow(url)` while the app is already running in the
 * background typically focuses the existing window *without navigating*,
 * so users tapping a push notification would land on whatever page the
 * app last showed (usually `/`) instead of the session link. Enumerate
 * existing same-origin clients first, navigate+focus one if present,
 * and only fall back to openWindow when no client exists (cold start).
 */
async function openOrFocus(target: string): Promise<void> {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of all) {
    const win = client as WindowClient
    try {
      const navigated = await win.navigate(target)
      if (navigated) {
        await (navigated as WindowClient).focus()
        return
      }
    } catch {
      // navigate() can reject for cross-origin or out-of-scope URLs —
      // fall through to focus-without-navigate, then openWindow.
    }
    try {
      await win.focus()
      return
    } catch {
      // client may be gone; continue searching.
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
