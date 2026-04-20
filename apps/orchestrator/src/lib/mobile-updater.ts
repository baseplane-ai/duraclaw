import { apiUrl, isNative } from './platform'

interface ManifestResponse {
  version?: string
  url?: string
  checksum?: string
  message?: string
}

export async function initMobileUpdater(): Promise<void> {
  if (!isNative()) return

  const { CapacitorUpdater } = await import('@capgo/capacitor-updater')

  try {
    await CapacitorUpdater.notifyAppReady()
  } catch (err) {
    console.warn('[updater] notifyAppReady failed', err)
  }

  try {
    const currentVersion = import.meta.env.VITE_APP_VERSION ?? '0.0.0'
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
  } catch (err) {
    console.warn('[updater] update check failed', err)
  }
}
