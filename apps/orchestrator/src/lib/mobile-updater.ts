import { apiUrl, isNative } from './platform'

interface ManifestResponse {
  version?: string
  url?: string
  checksum?: string
  message?: string
}

const NATIVE_PROMPT_KEY = 'duraclaw.apk-prompt.dismissed-version'

// Throttle OTA checks so foregrounding/visibility bursts don't hammer the
// manifest endpoint. 10 min is long enough to avoid flapping, short enough
// that a user who foregrounds the app after a publish picks up the update
// on a subsequent resume.
const MIN_RECHECK_INTERVAL_MS = 10 * 60 * 1000
let lastCheckTs = 0
let listenersInstalled = false

async function checkWebBundleUpdate(currentVersion: string): Promise<void> {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater')

  const res = await fetch(apiUrl('/api/mobile/updates/manifest'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'android', version_name: currentVersion }),
  })
  if (!res.ok) return
  const manifest = (await res.json()) as ManifestResponse
  if (!manifest.version || !manifest.url) return
  if (manifest.version === currentVersion) return

  // Capgo's own live state is the authoritative "what's running" — after a
  // `set()` + reload, the active bundle's `version` field reflects the
  // swapped bundle even before the baked-at-build `VITE_APP_VERSION` in
  // the new JS gets a chance to disagree. Checking this prevents the
  // download-set-reload-download loop we saw when the freshly-loaded
  // bundle re-triggered an update on itself.
  //
  // NOTE: we used to also short-circuit on a localStorage flag
  // `duraclaw.ota.last-applied-version`, but that flag was written BEFORE
  // `next()` + `reload()` resolved — so a download that succeeded but
  // failed to activate (WebView killed mid-flash, reload throw, etc.)
  // left the flag set for a version that was never actually running,
  // permanently locking the user onto the old bundle until the next
  // publish. Relying solely on `CapacitorUpdater.current()` removes that
  // stuck-state trap; Capgo only reports a bundle as `current` after it
  // has genuinely activated.
  try {
    const { bundle } = await CapacitorUpdater.current()
    if (bundle?.version === manifest.version) return
  } catch {
    // `current()` can throw on the first-ever install; fall through.
  }

  const bundle = await CapacitorUpdater.download({
    version: manifest.version,
    url: manifest.url,
    ...(manifest.checksum ? { checksum: manifest.checksum } : {}),
  })
  // Queue the new bundle as "next" and then explicitly reload the WebView.
  //
  // Capgo docs say `set()` self-reloads, but on Android we've observed the
  // pointer flipping to the new bundle while the WebView keeps serving the
  // old JS from cache until the process is killed (2026-04-22 debug: bundle
  // `3aa32b4` reported as current by Capgo while the WebView was still
  // executing `index-BNUdqtUp.js` from `16a6bf3` — only `am force-stop` +
  // relaunch picked up the new bundle).
  //
  // `next()` + `reload()` is Capgo's documented "recommended way to apply
  // updates": `next()` queues the bundle without destroying the current JS
  // context, and `reload()` triggers the same reload behaviour that happens
  // automatically when the app backgrounds — deterministic and doesn't
  // depend on Capgo's implicit reload-after-set firing on every device.
  await CapacitorUpdater.next({ id: bundle.id })
  await CapacitorUpdater.reload()
}

async function checkNativeApkUpdate(): Promise<void> {
  const { App } = await import('@capacitor/app')
  const info = await App.getInfo()
  const currentNative = info.version
  const res = await fetch(apiUrl('/api/mobile/apk/latest'))
  if (!res.ok) return
  const manifest = (await res.json()) as ManifestResponse
  if (!manifest.version || !manifest.url) return
  if (manifest.version === currentNative) return

  // Once-per-version dedupe: don't re-prompt after the user dismisses.
  if (typeof localStorage !== 'undefined') {
    if (localStorage.getItem(NATIVE_PROMPT_KEY) === manifest.version) return
  }

  const accepted = window.confirm(
    `A new version of Duraclaw (${manifest.version}) is available. Install now?`,
  )
  if (!accepted) {
    try {
      localStorage.setItem(NATIVE_PROMPT_KEY, manifest.version)
    } catch {}
    return
  }
  // Navigate the WebView to the APK URL. Android's download manager picks
  // up the application/vnd.android.package-archive mime type and hands off
  // to the package installer; REQUEST_INSTALL_PACKAGES permission allows
  // the install prompt to appear without extra gymnastics.
  window.location.href = manifest.url
}

/**
 * Run both update checks (web-bundle + APK). Throttled by
 * `MIN_RECHECK_INTERVAL_MS` so rapid foreground/visibility/online bursts
 * don't hammer the manifest endpoint. Pass `force: true` for the initial
 * launch check so the throttle doesn't swallow it.
 */
async function runUpdateChecks({
  force = false,
  reason,
}: {
  force?: boolean
  reason: string
}): Promise<void> {
  if (!isNative()) return
  const now = Date.now()
  if (!force && now - lastCheckTs < MIN_RECHECK_INTERVAL_MS) {
    return
  }
  lastCheckTs = now

  const currentVersion = import.meta.env.VITE_APP_VERSION ?? '0.0.0'
  console.log(`[updater] check (${reason}) — active bundle version`, currentVersion)
  try {
    await checkWebBundleUpdate(currentVersion)
  } catch (err) {
    console.warn('[updater] web-bundle check failed', err)
  }
  try {
    await checkNativeApkUpdate()
  } catch (err) {
    console.warn('[updater] apk check failed', err)
  }
}

/**
 * Install OS-level lifecycle listeners that re-run the OTA check whenever
 * the user returns to the app or regains connectivity. Without this, the
 * check only ran once per cold start — users who kept the app warm-cached
 * in the background could miss several releases in a row until Android
 * evicted the process.
 *
 * Listeners are idempotent (install-once guard). All three sources are
 * coalesced through the throttle in `runUpdateChecks()` so a single
 * resume that fires multiple events doesn't trigger multiple manifest
 * POSTs.
 */
async function installLifecycleListeners(): Promise<void> {
  if (listenersInstalled) return
  listenersInstalled = true

  // Capacitor `App.appStateChange` — the canonical "user came back"
  // signal on Android. Fires with `{ isActive: true }` on resume.
  try {
    const { App } = await import('@capacitor/app')
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void runUpdateChecks({ reason: 'app-resume' })
      }
    })
  } catch (err) {
    console.warn('[updater] failed to install App.appStateChange listener', err)
  }

  // Belt-and-braces: WebView visibility + browser `online` events. On
  // some Android OEM builds `appStateChange` can be flaky after long
  // backgrounding — these catch the slack. Throttled to the same window
  // so they won't double-fire with `appStateChange`.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void runUpdateChecks({ reason: 'visibility' })
      }
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      void runUpdateChecks({ reason: 'online' })
    })
  }
}

export async function initMobileUpdater(): Promise<void> {
  if (!isNative()) return

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
  try {
    await CapacitorUpdater.notifyAppReady()
  } catch (err) {
    console.warn('[updater] notifyAppReady failed', err)
  }

  // Install lifecycle listeners BEFORE the initial check so we don't
  // miss a resume that races with cold-start network latency.
  await installLifecycleListeners()

  // `force: true` — bypass the throttle for the initial launch check.
  await runUpdateChecks({ force: true, reason: 'launch' })
}
