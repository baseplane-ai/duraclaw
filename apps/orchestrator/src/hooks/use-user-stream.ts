/**
 * useUserStream — single root-level WS connection to UserSettingsDO (room =
 * userId) that replaces the per-collection `useInvalidationChannel` refetch
 * dance with a push-based delta-frame stream.
 *
 * Consumed by `createSyncedCollection` (in `~/db/synced-collection`) via the
 * module-level `subscribeUserStream(frameType, handler)` primitive, which is
 * callable OUTSIDE of React so collection factories that run at module load
 * can register without waiting for mount.
 *
 * Auth identity is set by the app shell once via `setUserStreamIdentity(userId)`
 * after auth resolves. When identity flips from null → userId the singleton
 * opens the WS; when it flips userId → null (logout) it closes.
 *
 * Reconnect is delegated to `partysocket`'s built-in exponential backoff +
 * jitter. On each post-disconnect `open` event, registered reconnect handlers
 * fire so synced collections can re-invalidate their queries and fall through
 * to the full-fetch path defined in B7 of GH#32.
 *
 * Wire: the DO broadcasts `SyncedCollectionFrame` JSON. We dispatch by the
 * frame's `collection` field against handlers keyed by the syncFrameType the
 * caller passed to `subscribeUserStream`.
 *
 * SSR-safe: all socket work short-circuits on `typeof window === 'undefined'`.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import PartySocket from 'partysocket'
import { useEffect, useState } from 'react'
import { createPartySocketAdapter } from '~/lib/connection-manager/adapters/partysocket-adapter'
import { connectionRegistry } from '~/lib/connection-manager/registry'
import type { ManagedConnection } from '~/lib/connection-manager/types'
import { logDelta } from '~/lib/delta-log'
import { isNative, wsBaseUrl } from '~/lib/platform'
import { attachWsDebug, wsHardFailEnabled } from '~/lib/ws-debug'

type FrameHandler = (frame: SyncedCollectionFrame<unknown>) => void
type ReconnectHandler = () => void

type ConnectionStatus = 'connecting' | 'open' | 'closed'

interface Listener {
  onStatus: (status: ConnectionStatus) => void
}

// ── Module-level singleton state ────────────────────────────────────────

const frameHandlers = new Map<string, Set<FrameHandler>>()
const reconnectHandlers = new Set<ReconnectHandler>()
const statusListeners = new Set<Listener>()

let socket: PartySocket | null = null
let userStreamAdapter: ManagedConnection | null = null
let userStreamUnregister: (() => void) | null = null
let currentUserId: string | null = null
let status: ConnectionStatus = 'closed'
// Tracks whether we've seen at least one `open` so subsequent `open` events
// count as reconnects rather than the initial connect.
let hasOpenedOnce = false
// Set by closeSocket() so the `close` listener doesn't flip status back to
// 'connecting' during a deliberate teardown. Cleared inside closeSocket
// after the close lands.
let intentionalClose = false
// Survives across socket swaps (identity change, logout→login). When a
// fresh socket opens and this is true, treat the open as a reconnect so
// synced-collection handlers re-invalidate their queries and back-fill
// any deltas missed during the close→open gap.
let hadPriorSocket = false

function setStatus(next: ConnectionStatus) {
  if (status === next) return
  status = next
  for (const l of statusListeners) l.onStatus(next)
}

function openSocket(userId: string) {
  if (typeof window === 'undefined') return
  if (socket) return

  const host = wsBaseUrl() || window.location.host
  hasOpenedOnce = false
  setStatus('connecting')

  const ws = new PartySocket({
    host,
    party: 'user-settings',
    room: userId,
    // Debug: `localStorage['duraclaw.debug.wsHardFail']='1'` + reload freezes
    // the socket on its first close instead of looping through partysocket's
    // infinite auto-reconnect (see ~/lib/ws-debug.ts).
    ...(wsHardFailEnabled() ? { maxRetries: 0 } : {}),
    // Capacitor WebView can't send cookies cross-origin (capacitor://localhost
    // → dura.baseplane.ai) and WS upgrades can't attach custom headers, so
    // native clients must pass the better-auth-capacitor bearer as a query
    // param. server.ts hoists `_authToken` to `Authorization: Bearer` before
    // dispatching `/parties/*`, so `getRequestSession` in UserSettingsDO
    // accepts the upgrade instead of rejecting with 401 → close code 1000.
    // Without this every connect attempt closes with `uptime=never-opened`
    // and partysocket retries forever.
    ...(isNative()
      ? {
          query: async (): Promise<Record<string, string>> => {
            const { getCapacitorAuthToken } = await import('better-auth-capacitor/client')
            const token = await getCapacitorAuthToken({ storagePrefix: 'better-auth' })
            return token ? { _authToken: token } : {}
          },
        }
      : {}),
  })

  attachWsDebug('user-stream', ws)

  ws.addEventListener('open', () => {
    // Treat as reconnect if either (a) this same socket has opened before
    // (partysocket internal auto-reconnect) or (b) a prior socket instance
    // existed and was torn down (identity swap — fresh socket, stale
    // subscribers need re-invalidate).
    const wasReconnect = hasOpenedOnce || hadPriorSocket
    hasOpenedOnce = true
    hadPriorSocket = true
    setStatus('open')
    if (wasReconnect) {
      for (const cb of reconnectHandlers) {
        try {
          cb()
        } catch (err) {
          console.warn('[user-stream] reconnect handler threw', err)
        }
      }
    }
  })

  ws.addEventListener('close', () => {
    // On an intentional close (identity change / logout) stay at 'closed';
    // the caller already set it. Only report 'connecting' for abnormal
    // closes, where partysocket will auto-reconnect.
    if (intentionalClose) return
    setStatus('connecting')
  })

  ws.addEventListener('message', (ev: MessageEvent) => {
    let frame: SyncedCollectionFrame<unknown>
    try {
      frame = JSON.parse(
        typeof ev.data === 'string' ? ev.data : '',
      ) as SyncedCollectionFrame<unknown>
    } catch (err) {
      console.warn('[user-stream] failed to parse frame', err)
      return
    }
    if (!frame || frame.type !== 'synced-collection-delta') return
    // Issue #40 Step 0: one line per arriving frame on the user-stream so
    // background-streaming continuity tests cover synced collections too.
    // No-op unless `localStorage['duraclaw.debug.deltaLog'] === '1'`.
    logDelta('user-stream', {
      collection: frame.collection,
      ops: frame.ops?.length,
    })
    const handlers = frameHandlers.get(frame.collection)
    if (!handlers || handlers.size === 0) return
    for (const h of handlers) {
      try {
        h(frame)
      } catch (err) {
        console.warn('[user-stream] frame handler threw', err)
      }
    }
  })

  socket = ws
  // GH#42: register with the connection-manager registry so the global
  // manager can coordinate reconnect on foreground/online events. This
  // runs outside any React lifecycle because the user-stream singleton
  // is module-level — register/unregister piggy-backs on open/close.
  userStreamAdapter = createPartySocketAdapter(ws, 'user-stream')
  userStreamUnregister = connectionRegistry.register(userStreamAdapter)
}

function closeSocket() {
  if (!socket) return
  intentionalClose = true
  if (userStreamUnregister) {
    try {
      userStreamUnregister()
    } catch {
      // ignore
    }
    userStreamUnregister = null
    userStreamAdapter = null
  }
  try {
    socket.close()
  } catch {
    // ignore
  }
  socket = null
  hasOpenedOnce = false
  setStatus('closed')
  intentionalClose = false
}

// ── Public non-React API ────────────────────────────────────────────────

/**
 * Set or clear the authenticated identity that drives the singleton WS.
 * Idempotent when passed the same userId. Pass `null` on logout to close.
 *
 * Called once by the app shell after auth resolves. Safe to call on SSR
 * (no-op).
 */
export function setUserStreamIdentity(userId: string | null): void {
  if (typeof window === 'undefined') return
  if (userId === currentUserId) return
  if (currentUserId) closeSocket()
  currentUserId = userId
  if (userId) openSocket(userId)
}

/**
 * Subscribe to WS delta frames whose `collection` field matches
 * `frameType`. Returns an unsubscribe function.
 *
 * Safe to call before `setUserStreamIdentity` — the subscription lives
 * on a module-level map and is honoured as soon as the WS opens.
 */
export function subscribeUserStream(frameType: string, handler: FrameHandler): () => void {
  let set = frameHandlers.get(frameType)
  if (!set) {
    set = new Set()
    frameHandlers.set(frameType, set)
  }
  set.add(handler)
  return () => {
    const current = frameHandlers.get(frameType)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) frameHandlers.delete(frameType)
  }
}

/**
 * Register a callback that fires after the WS reconnects following a
 * disconnect (not on the initial connect). Collection factories use this
 * to re-invalidate their query and fall through to the full-fetch path.
 * Returns an unsubscribe function.
 */
export function onUserStreamReconnect(cb: ReconnectHandler): () => void {
  reconnectHandlers.add(cb)
  return () => {
    reconnectHandlers.delete(cb)
  }
}

/**
 * Force an immediate reconnect. Primarily a test/debug affordance.
 */
export function reconnectUserStreamNow(): void {
  if (!socket) return
  try {
    socket.reconnect()
  } catch {
    // ignore
  }
}

/**
 * Test-only reset — clears singleton state between tests. Not exported
 * from the app barrel; only reachable from tests that import the file
 * directly.
 */
export function __resetUserStreamForTests(): void {
  closeSocket()
  frameHandlers.clear()
  reconnectHandlers.clear()
  statusListeners.clear()
  currentUserId = null
  status = 'closed'
  hasOpenedOnce = false
  hadPriorSocket = false
  intentionalClose = false
}

// ── React hook ──────────────────────────────────────────────────────────

/**
 * React hook exposing the live connection status for status-bar / dev UIs.
 * Mounting this hook does NOT open the socket — `setUserStreamIdentity`
 * does. Unmount is a cheap unsubscribe from the status listener set.
 */
export function useUserStream(): {
  status: ConnectionStatus
  reconnectNow: () => void
} {
  const [current, setCurrent] = useState<ConnectionStatus>(status)

  useEffect(() => {
    const listener: Listener = { onStatus: setCurrent }
    statusListeners.add(listener)
    // Sync in case status advanced between render and effect.
    setCurrent(status)
    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return {
    status: current,
    reconnectNow: reconnectUserStreamNow,
  }
}
