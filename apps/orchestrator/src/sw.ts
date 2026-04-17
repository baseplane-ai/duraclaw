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
  if (!data) {
    console.log('[sw:push] received push with no data — ignoring')
    return
  }
  console.log(
    '[sw:push] received',
    JSON.stringify({
      title: data.title,
      tag: data.tag,
      sessionId: data.sessionId,
      url: data.url,
      hasActions: Array.isArray(data.actions) ? data.actions.length : 0,
      hasActionToken: Boolean(data.actionToken),
    }),
  )
  // Append the URL to the body so the target is visible on the notification shade.
  // This is a debugging aid; remove once the notification-tap flow is verified.
  const bodyWithUrl = data.url ? `${data.body}\n${data.url}` : data.body
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: bodyWithUrl,
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
  console.log(
    `[sw:openOrFocus] target=${target} existingClients=${all.length}`,
    all.map((c) => ({
      url: (c as WindowClient).url,
      focused: (c as WindowClient).focused,
      visibilityState: (c as WindowClient).visibilityState,
    })),
  )
  for (const client of all) {
    const win = client as WindowClient
    try {
      console.log(`[sw:openOrFocus] postMessage+focus existing client url=${win.url}`)
      win.postMessage({ type: 'SW_NAVIGATE', url: target })
      await win.focus()
      console.log('[sw:openOrFocus] focused existing client, done')
      return
    } catch (err) {
      console.log(`[sw:openOrFocus] focus() rejected on ${win.url} — trying next`, err)
    }
  }
  console.log('[sw:openOrFocus] no usable existing client — openWindow(target)')
  const opened = await self.clients.openWindow(target)
  console.log(`[sw:openOrFocus] openWindow returned url=${opened?.url ?? 'null'}`)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { url, sessionId, actionToken } = event.notification.data ?? {}
  console.log(
    '[sw:click] notification clicked',
    JSON.stringify({ action: event.action || '(default)', url, sessionId }),
  )

  if ((event.action === 'approve' || event.action === 'deny') && sessionId && actionToken) {
    console.log(`[sw:click] tool-approval action=${event.action} sessionId=${sessionId}`)
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
    console.log('[sw:click] new-session action → openOrFocus("/")')
    event.waitUntil(openOrFocus('/'))
    return
  }

  // Open action or default click — open the session URL
  const target = url || '/'
  console.log(`[sw:click] open/default → openOrFocus("${target}")`)
  event.waitUntil(openOrFocus(target))
})
