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
 * Three drain channels feed the same `subscribers` set / pending slot,
 * to cover every delivery window observed on Android Capacitor:
 *
 *   1. Tap handler (`pushNotificationActionPerformed`) — fires when the
 *      OS hands the tap to Capacitor. On warm-start this often arrives
 *      BEFORE React has flushed `AgentOrchContent`'s `useEffect`, so the
 *      `subscribers` set is empty at this point and pending is retained.
 *
 *   2. Lifecycle drain (`foreground` / `visible`) — fires ~30 ms after
 *      the tap on warm-start (per adb logcat). By the time it arrives
 *      React has rendered, the subscriber is registered, and we can fan
 *      out the retained pending session id. This is the channel that
 *      fixes the warm-start "lands on previous tab" bug.
 *
 *   3. `consumePendingDeepLink()` — cold-start path. Called once from
 *      `AgentOrchContent`'s mount effect to drain any pending slot left
 *      over from a tap that fired before React mounted (e.g., when the
 *      app was fully killed and the OS launched it from the tap).
 *
 * Web builds short-circuit on `!isNative()` — `@capacitor/push-notifications`
 * is dynamic-imported so it stays out of the web bundle.
 */

import { lifecycleEventSource } from '~/lib/connection-manager/lifecycle'
import { isNative } from '~/lib/platform'

type DeepLinkSubscriber = (sessionId: string) => void
const subscribers = new Set<DeepLinkSubscriber>()

let pendingDeepLink: string | null = null
let initialized = false
let lifecycleUnsub: (() => void) | null = null

/**
 * Subscribe to live deep-link tap events. The subscriber receives the
 * target session id whenever a `pushNotificationActionPerformed` tap is
 * processed (or when the lifecycle drain re-fires a retained tap on the
 * next foreground / visible event — see the module docstring).
 *
 * Used by `AgentOrchContent` to react to taps that arrive AFTER first
 * mount (warm-start, foreground, or post-mount cold-start delivery).
 * The cold-start path still goes through `consumePendingDeepLink()` so
 * the very first commit can short-circuit the "restore last-active tab"
 * effect before any subscriber has registered.
 */
export function subscribeDeepLink(fn: DeepLinkSubscriber): () => void {
  subscribers.add(fn)
  console.info(`[push] subscribe count=${subscribers.size}`)
  return () => {
    subscribers.delete(fn)
    console.info(`[push] unsubscribe count=${subscribers.size}`)
  }
}

/**
 * Drain `pendingDeepLink` to the live subscribers, if any. Returns true
 * iff a fanout actually happened. When `subscribers.size === 0` the slot
 * is RETAINED (not cleared) so the next drain channel — either a later
 * lifecycle event or `consumePendingDeepLink()` from a fresh mount — can
 * still pick it up. The cold-start path expects this retention semantics.
 */
function fanoutPending(reason: string): boolean {
  if (!pendingDeepLink) return false
  const sessionId = extractSessionId(pendingDeepLink)
  if (!sessionId) {
    // Malformed slot — clear so we don't retry forever.
    pendingDeepLink = null
    return false
  }
  if (subscribers.size === 0) {
    console.info(
      `[push] fanout (${reason}) skipped — subscribers=0, retained pending=${pendingDeepLink}`,
    )
    return false
  }
  console.info(`[push] fanout (${reason}) — subscribers=${subscribers.size} sessionId=${sessionId}`)
  pendingDeepLink = null
  for (const fn of subscribers) {
    try {
      fn(sessionId)
    } catch (err) {
      console.warn('[push] subscriber threw:', err)
    }
  }
  return true
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
      console.info(
        `[push] notification tap → pending deep-link: ${pendingDeepLink} (subscribers=${subscribers.size})`,
      )

      // Try to deliver immediately. If subscribers is empty (warm-start
      // race: tap handler runs before React flushes the subscribe
      // effect), `fanoutPending` retains the slot so the lifecycle
      // drain (or a later `consumePendingDeepLink`) can pick it up.
      fanoutPending('tap')
    })

    // Lifecycle drain — on every `foreground` / `visible` event,
    // attempt to drain the pending slot. This is the warm-start fix:
    // by the time the lifecycle event fires (~30 ms after the OS hands
    // the tap to Capacitor on Android), React has flushed
    // `AgentOrchContent`'s subscribe effect and we can fan out.
    if (!lifecycleUnsub) {
      lifecycleUnsub = lifecycleEventSource.subscribe((event) => {
        if (event === 'foreground' || event === 'visible') {
          fanoutPending(`lifecycle:${event}`)
        }
      })
    }
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
  if (lifecycleUnsub) {
    lifecycleUnsub()
    lifecycleUnsub = null
  }
}

/**
 * Test-only. Sets the pending deep-link slot directly so tests can
 * exercise `consumePendingDeepLink()` without going through the
 * Capacitor mock. Pass a relative URL like `/?session=abc`.
 */
export function __setPendingDeepLinkForTests(url: string | null): void {
  pendingDeepLink = url
}
