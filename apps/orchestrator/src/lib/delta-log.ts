/**
 * Debug-gated WS delta logger.
 *
 * Enable in-page: `localStorage.setItem('duraclaw.debug.deltaLog', '1')`.
 * Disable: `localStorage.removeItem('duraclaw.debug.deltaLog')`.
 *
 * Output format (stable, grep-friendly): `[delta] ts=<ms> ch=<channel> …k=v`.
 * On Capacitor Android the WebView forwards `console.log` into `adb logcat`
 * under the `Capacitor/Console` tag, so a 15-min background streaming test
 * is one `adb logcat -s Capacitor/Console | grep '\[delta\]'` away.
 *
 * Intentionally zero-dep, SSR-safe, and short-circuits to a no-op when the
 * flag is unset so production hot paths pay only a single `localStorage.getItem`
 * per frame (memoised on first read).
 *
 * Issue #40 (foreground-service keep-alive) Step 0 instrumentation.
 */

let cachedEnabled: boolean | null = null

function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled
  if (typeof window === 'undefined') {
    cachedEnabled = false
    return false
  }
  try {
    cachedEnabled = window.localStorage.getItem('duraclaw.debug.deltaLog') === '1'
  } catch {
    cachedEnabled = false
  }
  return cachedEnabled
}

/** Force-refresh the enabled flag — call after toggling the localStorage key. */
export function refreshDeltaLogFlag(): void {
  cachedEnabled = null
}

/**
 * Log a WS-arrival event if the debug flag is set. `channel` identifies the
 * source stream (e.g. `'session'`, `'user-stream'`); remaining fields are
 * flattened to `k=v` pairs (values coerced via `String()`).
 */
export function logDelta(channel: string, fields: Record<string, unknown>): void {
  if (!isEnabled()) return
  const parts: string[] = [`ts=${Date.now()}`, `ch=${channel}`]
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  // Plain console.log so the WebView bridge forwards it verbatim.
  console.log(`[delta] ${parts.join(' ')}`)
}

/** Test-only: reset the cache between tests. */
export function __resetDeltaLogForTests(): void {
  cachedEnabled = null
}
