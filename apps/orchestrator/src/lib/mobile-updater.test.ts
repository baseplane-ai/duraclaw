/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock `./platform` so `isNative()` reports true (the guard at the top of
// `runUpdateChecks`) and `apiUrl` returns a simple predictable path.
vi.mock('./platform', () => ({
  isNative: () => true,
  apiUrl: (path: string) => path,
}))

// Capgo plugin mock — we expose `vi.fn()` handles per method so each test
// can override behaviour with `mockResolvedValueOnce` / `mockRejectedValueOnce`.
const capgoCurrent = vi.fn()
const capgoDownload = vi.fn()
const capgoNext = vi.fn()
const capgoReload = vi.fn()
const capgoNotifyAppReady = vi.fn()

vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    current: (...args: unknown[]) => capgoCurrent(...args),
    download: (...args: unknown[]) => capgoDownload(...args),
    next: (...args: unknown[]) => capgoNext(...args),
    reload: (...args: unknown[]) => capgoReload(...args),
    notifyAppReady: (...args: unknown[]) => capgoNotifyAppReady(...args),
  },
}))

// `@capacitor/app` is dynamically imported by `installLifecycleListeners`
// and `checkNativeApkUpdate`. Stub it so the tests never hit the real one.
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(),
    getInfo: vi.fn().mockResolvedValue({ version: '0.0.1' }),
  },
}))

// Dynamically import AFTER mocks are wired so the SUT sees the stubs.
// (Top-level `import` would evaluate before `vi.mock` hoisting in some
// configurations — the dynamic-import dance is defensive.)
async function loadSut() {
  return await import('./mobile-updater')
}

function makeManifestResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response
}

const manifestBody = {
  version: 'v2',
  url: 'https://example.com/bundle-v2.zip',
  checksum: 'sha256-xxx',
}

describe('checkWebBundleUpdate (bounded-retry guard)', () => {
  beforeEach(async () => {
    localStorage.clear()
    capgoCurrent.mockReset()
    capgoDownload.mockReset()
    capgoNext.mockReset()
    capgoReload.mockReset()
    capgoNotifyAppReady.mockReset()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeManifestResponse(manifestBody)))
    const sut = await loadSut()
    sut.__resetUpdaterStateForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('downloads and records a pending attempt when no prior record exists', async () => {
    // current() throws = first-ever install path
    capgoCurrent.mockRejectedValue(new Error('no bundle yet'))
    capgoDownload.mockResolvedValue({ id: 'bundle-v2-id', version: 'v2' })
    capgoNext.mockResolvedValue(undefined)
    capgoReload.mockResolvedValue(undefined)

    const { checkWebBundleUpdate } = await loadSut()
    await checkWebBundleUpdate('v1')

    expect(capgoDownload).toHaveBeenCalledTimes(1)
    expect(capgoNext).toHaveBeenCalledWith({ id: 'bundle-v2-id' })
    expect(capgoReload).toHaveBeenCalledTimes(1)

    const pending = JSON.parse(localStorage.getItem('duraclaw.ota.pending') ?? 'null')
    expect(pending).toMatchObject({ version: 'v2', attempts: 1 })
    expect(typeof pending.firstAttemptAt).toBe('number')
  })

  it('clears pending and skips download when baked currentVersion matches manifest', async () => {
    localStorage.setItem(
      'duraclaw.ota.pending',
      JSON.stringify({ version: 'v2', firstAttemptAt: Date.now(), attempts: 1 }),
    )

    const { checkWebBundleUpdate } = await loadSut()
    await checkWebBundleUpdate('v2')

    expect(capgoDownload).not.toHaveBeenCalled()
    expect(localStorage.getItem('duraclaw.ota.pending')).toBeNull()
  })

  it('clears pending and skips download when Capgo current() matches manifest', async () => {
    localStorage.setItem(
      'duraclaw.ota.pending',
      JSON.stringify({ version: 'v2', firstAttemptAt: Date.now(), attempts: 2 }),
    )
    capgoCurrent.mockResolvedValue({ bundle: { version: 'v2' } })

    const { checkWebBundleUpdate } = await loadSut()
    await checkWebBundleUpdate('v1')

    expect(capgoDownload).not.toHaveBeenCalled()
    expect(localStorage.getItem('duraclaw.ota.pending')).toBeNull()
  })

  it('increments the attempt counter when the same version still does not match', async () => {
    localStorage.setItem(
      'duraclaw.ota.pending',
      JSON.stringify({ version: 'v2', firstAttemptAt: Date.now() - 1000, attempts: 1 }),
    )
    capgoCurrent.mockResolvedValue({ bundle: { version: 'v1' } })
    capgoDownload.mockResolvedValue({ id: 'bundle-v2-id', version: 'v2' })
    capgoNext.mockResolvedValue(undefined)
    capgoReload.mockResolvedValue(undefined)

    const { checkWebBundleUpdate } = await loadSut()
    await checkWebBundleUpdate('v1')

    expect(capgoDownload).toHaveBeenCalledTimes(1)
    const pending = JSON.parse(localStorage.getItem('duraclaw.ota.pending') ?? 'null')
    expect(pending).toMatchObject({ version: 'v2', attempts: 2 })
  })

  it('stops downloading after MAX_ATTEMPTS within the backoff window', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    localStorage.setItem(
      'duraclaw.ota.pending',
      JSON.stringify({
        version: 'v2',
        firstAttemptAt: Date.now() - 5 * 60 * 1000, // 5 min ago — well under 30 min
        attempts: 3,
      }),
    )
    capgoCurrent.mockResolvedValue({ bundle: { version: 'v1' } })

    const { checkWebBundleUpdate } = await loadSut()
    await checkWebBundleUpdate('v1')

    expect(capgoDownload).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    // Record is preserved so a future attempt sees the same history.
    const pending = JSON.parse(localStorage.getItem('duraclaw.ota.pending') ?? 'null')
    expect(pending).toMatchObject({ version: 'v2', attempts: 3 })
    warn.mockRestore()
  })

  it('retries once the backoff window has elapsed', async () => {
    localStorage.setItem(
      'duraclaw.ota.pending',
      JSON.stringify({
        version: 'v2',
        firstAttemptAt: Date.now() - 31 * 60 * 1000, // past 30-min backoff
        attempts: 3,
      }),
    )
    capgoCurrent.mockResolvedValue({ bundle: { version: 'v1' } })
    capgoDownload.mockResolvedValue({ id: 'bundle-v2-id', version: 'v2' })
    capgoNext.mockResolvedValue(undefined)
    capgoReload.mockResolvedValue(undefined)

    const { checkWebBundleUpdate } = await loadSut()
    await checkWebBundleUpdate('v1')

    expect(capgoDownload).toHaveBeenCalledTimes(1)
    const pending = JSON.parse(localStorage.getItem('duraclaw.ota.pending') ?? 'null')
    expect(pending).toMatchObject({ version: 'v2', attempts: 4 })
  })

  it('resets the counter when the manifest advertises a different version', async () => {
    localStorage.setItem(
      'duraclaw.ota.pending',
      JSON.stringify({
        version: 'v2',
        firstAttemptAt: Date.now() - 5 * 60 * 1000,
        attempts: 3,
      }),
    )
    // Manifest now points at v3, not v2.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeManifestResponse({
          version: 'v3',
          url: 'https://example.com/bundle-v3.zip',
        }),
      ),
    )
    capgoCurrent.mockResolvedValue({ bundle: { version: 'v1' } })
    capgoDownload.mockResolvedValue({ id: 'bundle-v3-id', version: 'v3' })
    capgoNext.mockResolvedValue(undefined)
    capgoReload.mockResolvedValue(undefined)

    const { checkWebBundleUpdate } = await loadSut()
    await checkWebBundleUpdate('v1')

    expect(capgoDownload).toHaveBeenCalledTimes(1)
    const pending = JSON.parse(localStorage.getItem('duraclaw.ota.pending') ?? 'null')
    expect(pending).toMatchObject({ version: 'v3', attempts: 1 })
  })
})
