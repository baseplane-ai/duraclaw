/**
 * Native push deep-link handler.
 *
 * Registers `pushNotificationActionPerformed` BEFORE React mounts so the
 * Capacitor plugin's `retainUntilConsumed` buffer hands us the cold-start
 * tap event the instant we subscribe — long before `AgentOrchPage`'s
 * cold-start effect runs. The captured target session is stashed in a
 * module-level `pendingDeepLink` and consumed by `AgentOrchContent`'s
 * mount effect via `consumePendingDeepLink()`, which short-circuits the
 * "restore last-active tab" cold-start path so the user lands on the
 * notified session instead of whatever was active before.
 *
 * Web builds short-circuit on `!isNative()` — `@capacitor/push-notifications`
 * is dynamic-imported so it stays out of the web bundle.
 */

import { isNative } from '~/lib/platform'

type DeepLinkSubscriber = (sessionId: string) => void
const subscribers = new Set<DeepLinkSubscriber>()

let pendingDeepLink: string | null = null
let initialized = false

/**
 * Subscribe to live deep-link tap events. The subscriber receives the
 * target session id whenever a `pushNotificationActionPerformed` tap is
 * processed. Returns an unsubscribe function.
 *
 * Used by `AgentOrchContent` to react to taps that arrive AFTER first
 * mount (warm-start, foreground, or post-mount cold-start delivery).
 * The cold-start path still goes through `consumePendingDeepLink()` so
 * the very first commit can short-circuit the "restore last-active tab"
 * effect before any subscriber has registered.
 */
export function subscribeDeepLink(fn: DeepLinkSubscriber): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

/**
 * Parse a deep-link URL (relative or absolute) and return the session id
 * if it points at the root path with a `?session=<id>` query. Returns
 * null if the URL is malformed, points elsewhere, or is cross-origin.
 */
function extractSessionId(url: string): string | null {
  if (typeof window === 'undefined') return null
  let parsed: URL
  try {
    parsed = new URL(url, window.location.origin)
  } catch {
    return null
  }
  // Same-origin guard for absolute URLs.
  if (/^https?:\/\//i.test(url)) {
    if (parsed.origin !== window.location.origin) return null
  }
  if (parsed.pathname !== '/') return null
  const session = parsed.searchParams.get('session')
  return session && session.length > 0 ? session : null
}

/**
 * Idempotent. Safe to call eagerly from `bootstrap()`. No-op on web.
 */
export async function initNativePushDeepLink(): Promise<void> {
  if (!isNative()) return
  if (initialized) return
  initialized = true

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = (action.notification.data ?? {}) as {
        url?: string
        sessionId?: string
      }
      let target: string | null = null
      if (data.url) {
        target = data.url
      } else if (data.sessionId) {
        target = `/?session=${data.sessionId}`
      }
      if (!target) return

      const sessionId = extractSessionId(target)
      if (!sessionId) return

      // Normalise to a same-origin relative URL for `pendingDeepLink`.
      pendingDeepLink = `/?session=${sessionId}`
      console.info('[push] notification tap → pending deep-link:', pendingDeepLink)

      // Notify any live subscribers (warm-start / post-mount taps).
      // Cold-start taps that arrive before React mounts are picked up
      // via `consumePendingDeepLink()` instead.
      for (const fn of subscribers) {
        try {
          fn(sessionId)
        } catch (err) {
          console.warn('[push] subscriber threw:', err)
        }
      }
    })
  } catch (err) {
    console.warn('[push] native deep-link setup failed:', err)
  }
}

/**
 * Returns the pending deep-link target (relative URL) and clears it.
 * Called by `AgentOrchContent` on mount to short-circuit cold-start.
 */
export function consumePendingDeepLink(): string | null {
  if (!pendingDeepLink) return null
  const sessionId = extractSessionId(pendingDeepLink)
  pendingDeepLink = null
  if (sessionId) {
    console.info('[push] deep-link consumed:', sessionId)
  }
  return sessionId
}

/**
 * Test-only. Resets module state between vitest cases.
 */
export function __resetForTests(): void {
  pendingDeepLink = null
  initialized = false
  subscribers.clear()
}

/**
 * Test-only. Sets the pending deep-link slot directly so tests can
 * exercise `consumePendingDeepLink()` without going through the
 * Capacitor mock. Pass a relative URL like `/?session=abc`.
 */
export function __setPendingDeepLinkForTests(url: string | null): void {
  pendingDeepLink = url
}
