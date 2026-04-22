import { apiUrl, isNative } from './platform'

interface ManifestResponse {
  version?: string
  url?: string
  checksum?: string
  message?: string
}

const NATIVE_PROMPT_KEY = 'duraclaw.apk-prompt.dismissed-version'
const OTA_APPLIED_KEY = 'duraclaw.ota.last-applied-version'

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

  // Capgo's own live state — after a `set()` + reload, the active bundle's
  // `version` field is the authoritative "what's running", even before the
  // baked-at-build `VITE_APP_VERSION` in the new bundle gets a chance to
  // disagree. Checking this prevents the download-set-reload-download loop
  // we saw when the freshly-loaded bundle re-triggered an update on itself.
  try {
    const { bundle } = await CapacitorUpdater.current()
    if (bundle?.version === manifest.version) return
  } catch {
    // `current()` can throw on the first-ever install; fall through.
  }
  if (typeof localStorage !== 'undefined') {
    if (localStorage.getItem(OTA_APPLIED_KEY) === manifest.version) return
  }

  const bundle = await CapacitorUpdater.download({
    version: manifest.version,
    url: manifest.url,
    ...(manifest.checksum ? { checksum: manifest.checksum } : {}),
  })
  try {
    localStorage.setItem(OTA_APPLIED_KEY, manifest.version)
  } catch {}
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

export async function initMobileUpdater(): Promise<void> {
  if (!isNative()) return

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
  try {
    await CapacitorUpdater.notifyAppReady()
  } catch (err) {
    console.warn('[updater] notifyAppReady failed', err)
  }

  const currentVersion = import.meta.env.VITE_APP_VERSION ?? '0.0.0'
  console.log('[updater] init — active bundle version', currentVersion)
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
