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
    event.waitUntil(self.clients.openWindow('/'))
    return
  }

  // Open action or default click — open the session URL
  event.waitUntil(self.clients.openWindow(url || '/'))
})
