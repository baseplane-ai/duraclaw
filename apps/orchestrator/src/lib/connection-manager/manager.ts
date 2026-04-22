import { type LifecycleEvent, lifecycleEventSource } from './lifecycle'
import { connectionRegistry } from './registry'
import type { ManagedConnection } from './types'

const STALE_THRESHOLD_MS = 5_000
const MAX_STAGGER_MS = 500
const LOG_RING_SIZE = 10

type ReconnectReason = 'foreground' | 'online' | 'manual'

interface ReconnectLogEntry {
  id: string
  lastSeenMs: number
  delay: number
  reason: ReconnectReason
  ts: number
}

export interface ConnectionManagerStartOptions {
  /** Test-only override for `Math.random`. Injected delay source. */
  random?: () => number
}

// Module-level singleton state.
let randomFn: () => number = Math.random
let unsubscribe: (() => void) | null = null
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastReconnectLog: ReconnectLogEntry[] = []

function logReconnect(entry: ReconnectLogEntry): void {
  lastReconnectLog.push(entry)
  if (lastReconnectLog.length > LOG_RING_SIZE) {
    lastReconnectLog.splice(0, lastReconnectLog.length - LOG_RING_SIZE)
  }
  // Always-on — reconnects are rare enough to be low-noise, and this is
  // the only signal that diagnoses WS thrash on release APKs via logcat.
  console.info(
    `[cm] reconnect id=${entry.id} lastSeenMs=${entry.lastSeenMs} delay=${entry.delay} reason=${entry.reason}`,
  )
}

function scheduleReconnect(conn: ManagedConnection, reason: ReconnectReason): void {
  // Cancel any pending timer for the same id — prevents stampede on
  // rapid foreground/background/online/offline oscillation.
  const prev = pendingTimers.get(conn.id)
  if (prev) clearTimeout(prev)

  const delay = Math.floor(randomFn() * MAX_STAGGER_MS)
  const lastSeenMs = Date.now() - conn.lastSeenTs

  const timer = setTimeout(() => {
    pendingTimers.delete(conn.id)
    try {
      conn.reconnect(undefined, `cm-${reason}`)
    } catch (err) {
      console.warn('[cm] reconnect threw', conn.id, err)
    }
  }, delay)
  pendingTimers.set(conn.id, timer)

  logReconnect({ id: conn.id, lastSeenMs, delay, reason, ts: Date.now() })
}

function onLifecycleEvent(event: LifecycleEvent): void {
  // `foreground` and `online` trigger coordinated reconnect; the
  // others are hints (for future use or downstream consumers) but do
  // not tear down sockets — we let the OS kill them and pick up on
  // the next live signal.
  if (event !== 'foreground' && event !== 'online') return

  const now = Date.now()
  for (const conn of connectionRegistry.snapshot()) {
    // Skip OPEN and CONNECTING sockets. OPEN: socket is live, tearing
    // it down triggers the Agents-SDK re-handshake pathology observed
    // in logcat. CONNECTING: partysocket is already mid-retry — calling
    // reconnect() here interrupts and resets its internal backoff, so
    // a healthy 1s-5s exponential ramp collapses to ~300ms hot-loop
    // retries that never recover. Only CLOSED/CLOSING sockets benefit
    // from the nudge (partysocket's own retry loop handles the normal
    // case). Zombie OPEN sockets will flip readyState on next failed
    // send and get picked up on the following tick.
    if (conn.readyState === WebSocket.OPEN || conn.readyState === WebSocket.CONNECTING) continue
    if (now - conn.lastSeenTs > STALE_THRESHOLD_MS) {
      scheduleReconnect(conn, event)
    }
  }
}

function start(options?: ConnectionManagerStartOptions): void {
  if (options?.random) randomFn = options.random
  if (unsubscribe) return // double-start no-op
  unsubscribe = lifecycleEventSource.subscribe(onLifecycleEvent)
}

function stop(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  for (const t of pendingTimers.values()) clearTimeout(t)
  pendingTimers.clear()
}

/**
 * Force-reconnect every registered connection immediately with no
 * stagger and no `lastSeenTs` gate. Test/debug affordance; the normal
 * foreground/online path goes through `scheduleReconnect`.
 */
function reconnectAll(): void {
  for (const conn of connectionRegistry.snapshot()) {
    try {
      conn.reconnect(undefined, 'cm-manual')
    } catch (err) {
      console.warn('[cm] reconnect threw', conn.id, err)
    }
  }
}

/** Test-only: drop timers + subscription + reset random to Math.random. */
function __resetForTests(): void {
  stop()
  randomFn = Math.random
  lastReconnectLog.length = 0
}

export const connectionManager = {
  start,
  stop,
  reconnectAll,
  get lastReconnectLog(): ReadonlyArray<ReconnectLogEntry> {
    return lastReconnectLog
  },
  __resetForTests,
}

// Dev-only: expose on `window` for manual inspection via `scripts/axi eval`.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as { __connectionManager?: unknown }).__connectionManager = connectionManager
}
