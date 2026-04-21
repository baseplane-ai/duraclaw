/**
 * WS debug instrumentation — helpers for diagnosing flappy/sticky WebSocket
 * connections (the "yellow dot that never turns green" scenario).
 *
 * partysocket auto-reconnects with `maxRetries: Infinity` by default, and the
 * UI collapses every non-OPEN readyState into a single yellow dot, so the
 * close code / reason / URL of the underlying failure never surfaces. This
 * module exposes two things:
 *
 * 1. `attachWsDebug(channel, socket)` — always-on one-line `console.warn` on
 *    every `close` / `error` carrying code, reason, url, and time since the
 *    last `open`. Opens are `console.info`. Rare during healthy operation;
 *    noisy exactly when you need the signal.
 *
 * 2. `wsHardFailEnabled()` — gated by `localStorage['duraclaw.debug.wsHardFail']`.
 *    Consumers pass `maxRetries: 0` to partysocket when this returns true, so
 *    the socket stays dead on the first close instead of looping silently.
 *
 * Enable hard-fail in devtools:
 *   localStorage.setItem('duraclaw.debug.wsHardFail', '1'); location.reload()
 * Disable:
 *   localStorage.removeItem('duraclaw.debug.wsHardFail'); location.reload()
 */

let cachedHardFail: boolean | null = null

export function wsHardFailEnabled(): boolean {
  if (cachedHardFail !== null) return cachedHardFail
  if (typeof window === 'undefined') {
    cachedHardFail = false
    return false
  }
  try {
    cachedHardFail = window.localStorage.getItem('duraclaw.debug.wsHardFail') === '1'
  } catch {
    cachedHardFail = false
  }
  return cachedHardFail
}

export function __resetWsDebugForTests(): void {
  cachedHardFail = null
}

interface MinimalWs {
  url?: string
  readyState?: number
  addEventListener: (type: 'open' | 'close' | 'error', listener: (ev: Event) => void) => void
  removeEventListener: (type: 'open' | 'close' | 'error', listener: (ev: Event) => void) => void
}

/**
 * Attach one-liner lifecycle logging to a PartySocket / WebSocket-like object.
 * Returns an unsubscribe fn that removes all three listeners.
 */
export function attachWsDebug(channel: string, socket: MinimalWs): () => void {
  let openAt = 0
  const hardFail = wsHardFailEnabled()

  const onOpen = () => {
    openAt = Date.now()
    const url = socket.url ?? '(unknown)'
    console.info(
      `[ws:${channel}] open url=${url}${hardFail ? ' (hard-fail mode: maxRetries=0)' : ''}`,
    )
  }
  const onClose = (ev: Event) => {
    const ce = ev as CloseEvent
    const uptime = openAt > 0 ? `${Date.now() - openAt}ms` : 'never-opened'
    console.warn(
      `[ws:${channel}] close code=${ce.code} reason=${JSON.stringify(ce.reason ?? '')} wasClean=${ce.wasClean} uptime=${uptime} url=${socket.url ?? '(unknown)'}${hardFail ? ' (will NOT reconnect — hard-fail)' : ''}`,
    )
    openAt = 0
  }
  const onError = (ev: Event) => {
    console.warn(
      `[ws:${channel}] error readyState=${socket.readyState ?? '?'} url=${socket.url ?? '(unknown)'}`,
      ev,
    )
  }

  socket.addEventListener('open', onOpen)
  socket.addEventListener('close', onClose)
  socket.addEventListener('error', onError)

  return () => {
    socket.removeEventListener('open', onOpen)
    socket.removeEventListener('close', onClose)
    socket.removeEventListener('error', onError)
  }
}
