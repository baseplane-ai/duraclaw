import { apiUrl, isNative } from './platform'

interface ManifestResponse {
  version?: string
  url?: string
  checksum?: string
  message?: string
}

const NATIVE_PROMPT_KEY = 'duraclaw.apk-prompt.dismissed-version'

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

  const bundle = await CapacitorUpdater.download({
    version: manifest.version,
    url: manifest.url,
    ...(manifest.checksum ? { checksum: manifest.checksum } : {}),
  })
  await CapacitorUpdater.set({ id: bundle.id })
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
