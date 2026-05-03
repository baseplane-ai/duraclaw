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
  wsDebugInfo.clear()
  wsDebugListeners.clear()
}

interface MinimalWs {
  url?: string
  readyState?: number
  addEventListener: (type: 'open' | 'close' | 'error', listener: (ev: Event) => void) => void
  removeEventListener: (type: 'open' | 'close' | 'error', listener: (ev: Event) => void) => void
}

/**
 * Per-channel rolling diagnostic snapshot. Surfaced via `getWsDebugInfo` and
 * `subscribeWsDebug` so the StatusBar can render the last close code/reason
 * on tap — needed because mobile users can't see the `console.warn` lines
 * `attachWsDebug` writes without remote-debugging the device.
 */
export interface WsDebugInfo {
  channel: string
  url: string | null
  lastOpenAt: number | null
  lastCloseAt: number | null
  lastCloseCode: number | null
  lastCloseReason: string | null
  lastCloseWasClean: boolean | null
  lastCloseUptimeMs: number | null
  lastErrorAt: number | null
  openCount: number
  closeCount: number
  errorCount: number
}

const wsDebugInfo = new Map<string, WsDebugInfo>()
const wsDebugListeners = new Map<string, Set<() => void>>()

function emptyInfo(channel: string): WsDebugInfo {
  return {
    channel,
    url: null,
    lastOpenAt: null,
    lastCloseAt: null,
    lastCloseCode: null,
    lastCloseReason: null,
    lastCloseWasClean: null,
    lastCloseUptimeMs: null,
    lastErrorAt: null,
    openCount: 0,
    closeCount: 0,
    errorCount: 0,
  }
}

function notify(channel: string): void {
  const set = wsDebugListeners.get(channel)
  if (!set) return
  for (const cb of set) {
    try {
      cb()
    } catch (err) {
      console.warn('[ws-debug] listener threw', err)
    }
  }
}

export function getWsDebugInfo(channel: string): WsDebugInfo | null {
  return wsDebugInfo.get(channel) ?? null
}

export function subscribeWsDebug(channel: string, cb: () => void): () => void {
  let set = wsDebugListeners.get(channel)
  if (!set) {
    set = new Set()
    wsDebugListeners.set(channel, set)
  }
  set.add(cb)
  return () => {
    const current = wsDebugListeners.get(channel)
    if (!current) return
    current.delete(cb)
    if (current.size === 0) wsDebugListeners.delete(channel)
  }
}

/**
 * Attach one-liner lifecycle logging to a PartySocket / WebSocket-like object.
 * Returns an unsubscribe fn that removes all three listeners.
 */
export function attachWsDebug(channel: string, socket: MinimalWs): () => void {
  let openAt = 0
  const hardFail = wsHardFailEnabled()
  const info = wsDebugInfo.get(channel) ?? emptyInfo(channel)
  wsDebugInfo.set(channel, info)

  const onOpen = () => {
    openAt = Date.now()
    const url = socket.url ?? '(unknown)'
    console.info(
      `[ws:${channel}] open url=${url}${hardFail ? ' (hard-fail mode: maxRetries=0)' : ''}`,
    )
    info.url = socket.url ?? info.url
    info.lastOpenAt = openAt
    info.openCount += 1
    notify(channel)
  }
  const onClose = (ev: Event) => {
    // partysocket wraps the underlying browser CloseEvent: it dispatches its
    // own Event whose `.reason` field is the actual native CloseEvent (with
    // the real `.code` / `.wasClean`). Unwrap so we capture the meaningful
    // values, falling back to the outer event when consumers attach to a
    // raw WebSocket directly.
    const outer = ev as CloseEvent & { reason?: unknown }
    const inner =
      outer.reason && typeof outer.reason === 'object'
        ? (outer.reason as Partial<CloseEvent> & {
            code?: number
            wasClean?: boolean
            reason?: string
          })
        : null
    const code = inner?.code ?? (typeof outer.code === 'number' ? outer.code : null)
    const reason =
      typeof inner?.reason === 'string'
        ? inner.reason
        : typeof outer.reason === 'string'
          ? outer.reason
          : ''
    const wasClean = inner?.wasClean ?? outer.wasClean ?? null
    const uptimeMs = openAt > 0 ? Date.now() - openAt : null
    const uptime = uptimeMs == null ? 'never-opened' : `${uptimeMs}ms`
    console.warn(
      `[ws:${channel}] close code=${code ?? '?'} reason=${JSON.stringify(reason)} wasClean=${wasClean} uptime=${uptime} url=${socket.url ?? '(unknown)'}${hardFail ? ' (will NOT reconnect — hard-fail)' : ''}`,
    )
    openAt = 0
    info.url = socket.url ?? info.url
    info.lastCloseAt = Date.now()
    info.lastCloseCode = code
    info.lastCloseReason = reason
    info.lastCloseWasClean = wasClean
    info.lastCloseUptimeMs = uptimeMs
    info.closeCount += 1
    notify(channel)
  }
  const onError = (ev: Event) => {
    console.warn(
      `[ws:${channel}] error readyState=${socket.readyState ?? '?'} url=${socket.url ?? '(unknown)'}`,
      ev,
    )
    info.url = socket.url ?? info.url
    info.lastErrorAt = Date.now()
    info.errorCount += 1
    notify(channel)
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
