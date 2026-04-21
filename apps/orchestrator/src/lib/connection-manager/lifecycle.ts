import { isNative } from '~/lib/platform'

export type LifecycleEvent =
  | 'foreground'
  | 'background'
  | 'online'
  | 'offline'
  | 'visible'
  | 'hidden'

type Listener = (event: LifecycleEvent) => void

/**
 * Unified cross-platform lifecycle event source. Fans out six events to
 * every subscriber:
 *
 *   foreground / background — Capacitor `App.appStateChange`
 *   online / offline        — Capacitor `Network.networkStatusChange`
 *                           + browser `window.online`/`offline`
 *   visible / hidden        — `document.visibilitychange`
 *
 * Capacitor plugins are dynamically imported behind `isNative()` so the
 * web bundle does not pull them in. The web browser listeners are
 * installed on every platform (they also fire on Capacitor WebView, as
 * a redundant supplementary signal — the reconnect path is idempotent
 * on `lastSeenTs` so duplicates are harmless).
 *
 * On the first subscribe, listeners are installed; on the last
 * unsubscribe they are torn down. Multiple concurrent subscribers are
 * supported (tests can subscribe alongside the ConnectionManager).
 */

const listeners = new Set<Listener>()
let teardown: (() => void) | null = null

function emit(event: LifecycleEvent): void {
  for (const l of listeners) {
    try {
      l(event)
    } catch (err) {
      console.warn('[cm-lifecycle] listener threw', err)
    }
  }
}

function install(): () => void {
  if (typeof window === 'undefined') {
    // SSR: no-op teardown.
    return () => {}
  }

  // Web listeners (always installed — Capacitor WebView honors them).
  const onVisibilityChange = () => emit(document.hidden ? 'hidden' : 'visible')
  const onOnline = () => emit('online')
  const onOffline = () => emit('offline')
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  // Capacitor listeners (native only, dynamically imported).
  let cancelled = false
  const capacitorRemovers: Array<() => void> = []

  if (isNative()) {
    ;(async () => {
      try {
        const [{ App }, { Network }] = await Promise.all([
          import('@capacitor/app'),
          import('@capacitor/network'),
        ])
        if (cancelled) return

        const appHandle = await App.addListener('appStateChange', ({ isActive }) => {
          emit(isActive ? 'foreground' : 'background')
        })
        if (cancelled) {
          appHandle.remove()
          return
        }
        capacitorRemovers.push(() => {
          appHandle.remove()
        })

        const netHandle = await Network.addListener('networkStatusChange', ({ connected }) => {
          emit(connected ? 'online' : 'offline')
        })
        if (cancelled) {
          netHandle.remove()
          return
        }
        capacitorRemovers.push(() => {
          netHandle.remove()
        })

        // Seed: Capacitor's networkStatusChange does NOT fire on launch.
        // Without this, launching offline leaves the manager thinking
        // we're online — no reconnect on regain.
        try {
          const status = await Network.getStatus()
          if (cancelled) return
          emit(status.connected ? 'online' : 'offline')
        } catch (err) {
          console.warn('[cm-lifecycle] Network.getStatus threw', err)
        }
      } catch (err) {
        console.warn('[cm-lifecycle] Capacitor import failed', err)
      }
    })()
  }

  return () => {
    cancelled = true
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    for (const r of capacitorRemovers) {
      try {
        r()
      } catch {
        // ignore
      }
    }
  }
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  if (listeners.size === 1) {
    teardown = install()
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && teardown) {
      teardown()
      teardown = null
    }
  }
}

/** Test-only: drop all listeners and tear down installed handlers. */
function __resetForTests(): void {
  listeners.clear()
  if (teardown) {
    teardown()
    teardown = null
  }
}

export const lifecycleEventSource = {
  subscribe,
  __resetForTests,
}
