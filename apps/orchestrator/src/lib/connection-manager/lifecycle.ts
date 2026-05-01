import { isExpoNative, isNative } from '~/lib/platform'

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
  // Always-on so Capacitor Android release APKs surface these via
  // `adb logcat -s Capacitor/Console:V`. Essential for diagnosing
  // whether thrash is lifecycle-driven (foreground/online storms) vs
  // transport-driven (WS close codes).
  console.info(`[cm-lifecycle] ${event}`)
  for (const l of listeners) {
    try {
      l(event)
    } catch (err) {
      console.warn('[cm-lifecycle] listener threw', err)
    }
  }
}

function install(): () => void {
  // Expo native (Metro): no `window`/`document` — use AppState +
  // @react-native-community/netinfo for the same six events.
  if (isExpoNative()) {
    return installExpoNative()
  }

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

/**
 * Expo native installer — replaces the Capacitor branch on Metro builds.
 *
 *   foreground / background — `AppState.addEventListener('change', ...)`
 *   online / offline        — `NetInfo.addEventListener(...)` + a
 *                             one-shot `NetInfo.fetch()` seed (parity
 *                             with the Capacitor `Network.getStatus()`
 *                             seed: launch-while-offline must emit
 *                             `offline` so the reconnect path arms on
 *                             regain).
 *   visible / hidden        — coalesced with foreground/background on
 *                             native (no separate document.visibility
 *                             concept). We emit foreground/background
 *                             only; consumers that read `visible/hidden`
 *                             on web treat them equivalently.
 */
function installExpoNative(): () => void {
  let cancelled = false
  const removers: Array<() => void> = []

  ;(async () => {
    try {
      const [{ AppState }, NetInfoMod] = await Promise.all([
        import('react-native'),
        import(/* @vite-ignore */ '@react-native-community/netinfo'),
      ])
      if (cancelled) return

      const NetInfo =
        (
          NetInfoMod as unknown as {
            default?: {
              addEventListener: (...a: unknown[]) => () => void
              fetch: () => Promise<{ isConnected: boolean }>
            }
          }
        ).default ??
        (NetInfoMod as unknown as {
          addEventListener: (...a: unknown[]) => () => void
          fetch: () => Promise<{ isConnected: boolean }>
        })

      const appSub = AppState.addEventListener('change', (state) => {
        emit(state === 'active' ? 'foreground' : 'background')
      })
      removers.push(() => appSub.remove())

      const netUnsub = NetInfo.addEventListener((state: { isConnected: boolean }) => {
        emit(state.isConnected ? 'online' : 'offline')
      })
      removers.push(() => netUnsub())

      // Seed: NetInfo's listener does NOT fire on init. Without this,
      // launching offline leaves the manager thinking we're online —
      // no reconnect on regain. (Same shape as the Capacitor branch.)
      try {
        const state = await NetInfo.fetch()
        if (cancelled) return
        emit(state.isConnected ? 'online' : 'offline')
      } catch (err) {
        console.warn('[cm-lifecycle] NetInfo.fetch threw', err)
      }
    } catch (err) {
      console.warn('[cm-lifecycle] expo-native lifecycle import failed', err)
    }
  })()

  return () => {
    cancelled = true
    for (const r of removers) {
      try {
        r()
      } catch {
        // ignore
      }
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
