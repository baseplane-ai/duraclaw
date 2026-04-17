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

// Push event handler
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
 * We've tried and ruled out every "navigate from the service worker" approach:
 *   - `clients.openWindow(url)` on Android Chrome standalone focuses the existing
 *     window WITHOUT navigating — user sees whatever page they were last on.
 *   - `WindowClient.navigate(url)` silently no-ops or returns null on Android Chrome
 *     standalone PWAs, even when the client is controlled and the URL is in scope.
 *   - `client.postMessage()` + `addEventListener('message')` requires
 *     `navigator.serviceWorker.startMessages()` which is easy to miss, and even then
 *     delivery is unreliable when the page is backgrounded/suspended on mobile.
 *
 * **BroadcastChannel** is a completely independent messaging API available in both
 * service workers and page contexts. It has zero setup requirements (no startMessages),
 * doesn't care about controlled vs uncontrolled clients, and reliably delivers
 * messages to same-origin browsing contexts. The app's useSwNavigate hook listens
 * on the same channel name and routes through TanStack Router.
 *
 * For cold start (no existing client), we still fall back to openWindow(target),
 * which works because it's opening a brand-new window at the correct URL.
 */
/**
 * Persist the target URL in Cache Storage as a durable pending-navigation
 * record. Both the SW and the page can read/write Cache Storage, and writes
 * survive freeze-dry / SW→client message drops. The page consumes this on
 * visibilitychange in useSwNavigate.
 *
 * Key: opaque internal cache `sw-pending-nav`, single entry at `/pending-nav`.
 * Value: plain text URL string.
 */
async function stashPendingNav(target: string): Promise<void> {
  try {
    const cache = await caches.open('sw-pending-nav')
    await cache.put(
      '/pending-nav',
      new Response(target, { headers: { 'Content-Type': 'text/plain' } }),
    )
    console.log(`[sw:openOrFocus] stashed pending-nav in Cache Storage url=${target}`)
  } catch (err) {
    console.log(`[sw:openOrFocus] failed to stash pending-nav`, err)
  }
}

async function openOrFocus(target: string): Promise<void> {
  // STEP 1: Stash in Cache Storage first — this is the durable channel that
  // survives freeze-dry. Even if every other mechanism fails, the app will
  // pick it up on visibilitychange.
  await stashPendingNav(target)

  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  console.log(
    `[sw:openOrFocus] target=${target} existingClients=${all.length}`,
    all.map((c) => ({
      url: (c as WindowClient).url,
      focused: (c as WindowClient).focused,
      visibilityState: (c as WindowClient).visibilityState,
    })),
  )

  if (all.length > 0) {
    // Warm path: broadcast the URL on BroadcastChannel, then focus the first
    // usable window. The app-side listener will call location.assign().
    // These are best-effort fast paths — if they fail, the Cache Storage
    // fallback + visibilitychange handler will still deliver.
    console.log(`[sw:openOrFocus] broadcasting SW_NAVIGATE on BroadcastChannel`)
    const bc = new BroadcastChannel('sw-nav')
    bc.postMessage({ type: 'SW_NAVIGATE', url: target })
    bc.close()

    // Also send via client.postMessage as a belt-and-suspenders fallback
    // (in case BroadcastChannel is delayed on some browser versions).
    for (const client of all) {
      const win = client as WindowClient
      try {
        win.postMessage({ type: 'SW_NAVIGATE', url: target })
        await win.focus()
        console.log(`[sw:openOrFocus] focused existing client url=${win.url}`)
        return
      } catch (err) {
        console.log(`[sw:openOrFocus] focus() rejected on ${win.url}`, err)
      }
    }
  }

  // Cold path: no existing client — openWindow works correctly for new windows.
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
