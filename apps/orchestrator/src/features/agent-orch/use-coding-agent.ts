/**
 * Hook for connecting to a SessionDO via the agents/react useAgent hook.
 *
 * Render source for the message list is `messagesCollection` (OPFS-persisted)
 * via `useMessagesCollection`. Server-authoritative per-session state
 * (status, numTurns, cost, duration, context usage, kata state, worktreeInfo)
 * is read from `sessionsCollection` via `useSession(agentName)` — the synced
 * collection hydrates from D1 and stays live via `agent_sessions` WS delta
 * frames (Spec #37 P2a). Per-turn branch info is a reactive read from
 * `branchInfoCollection` via `useBranchInfo` — DO-pushed on snapshot
 * payloads (B7). WS-transient `wsReadyState` lives in the local-only
 * `sessionLocalCollection`.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { createTransaction } from '@tanstack/db'
import { useAgent } from 'agents/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type * as Y from 'yjs'
import { type BranchInfoRow, createBranchInfoCollection } from '~/db/branch-info-collection'
import { queryClient } from '~/db/db-instance'
import {
  type CachedMessage,
  computeTailCursor,
  createMessagesCollection,
} from '~/db/messages-collection'
import { sessionLocalCollection } from '~/db/session-local-collection'
import { useMessagesCollection } from '~/hooks/use-messages-collection'
import { useSession } from '~/hooks/use-sessions-collection'
import { setStallReason } from '~/lib/chain-stall-store'
import { createPartySocketAdapter } from '~/lib/connection-manager/adapters/partysocket-adapter'
import { useManagedConnection } from '~/lib/connection-manager/hooks'
import { logDelta } from '~/lib/delta-log'
import { parseJsonField } from '~/lib/json'
import { contentToParts } from '~/lib/message-parts'
import { isNative, wsBaseUrl } from '~/lib/platform'
// `BranchInfoRow` still used by navigateBranch's branchInfoCollection read.
import type {
  ContentBlock,
  ContextUsage,
  GateResponse,
  KataSessionState,
  SessionMessage,
  SessionMessagePart,
  SpawnConfig,
} from '~/lib/types'
import { attachWsDebug, wsHardFailEnabled } from '~/lib/ws-debug'

export type { ContentBlock, ContextUsage, GateResponse, SpawnConfig }

export interface GatewayEvent {
  type: string
  [key: string]: unknown
}

export interface UseCodingAgentResult {
  messages: SessionMessage[]
  kataState: KataSessionState | null
  contextUsage: ContextUsage | null
  wsReadyState: number
  isConnecting: boolean
  spawn: (config: SpawnConfig) => Promise<unknown>
  stop: (reason?: string) => Promise<unknown>
  abort: (reason?: string) => Promise<unknown>
  /**
   * Force-terminate a wedged session. Triggers the DO's `forceStop` RPC
   * which (a) transitions state → idle, (b) best-effort sends `abort` over
   * the WS, and (c) POSTs `/sessions/:id/kill` on the gateway to SIGTERM
   * the runner process by PID. The gateway HTTP leg rescues the
   * WS-dead-but-runner-alive case that the in-band abort can't reach.
   */
  forceStop: (reason?: string) => Promise<unknown>
  interrupt: () => Promise<unknown>
  getContextUsage: () => Promise<unknown>
  resolveGate: (gateId: string, response: GateResponse) => Promise<unknown>
  sendMessage: (content: string | ContentBlock[]) => Promise<unknown>
  /** Submit a collaborative draft (Y.Text): optimistically clear, RPC send, restore on failure. */
  submitDraft: (yText: Y.Text) => Promise<{ ok: boolean; error?: string; sent?: boolean }>
  /** Spawn a fresh SDK session with the current transcript prepended; recovers from orphaned sdk_session_id. */
  forkWithHistory: (content: string | ContentBlock[]) => Promise<unknown>
  /** Retry the gateway dial — used by DisconnectedBanner for reattach. */
  reattach: () => Promise<unknown>
  /** Force-resume from the on-disk JSONL transcript — escape hatch for stuck sessions. */
  resumeFromTranscript: () => Promise<unknown>
  rewind: (turnIndex: number) => Promise<{ ok: boolean; error?: string }>
  resubmitMessage: (
    messageId: string,
    content: string,
  ) => Promise<{ ok: boolean; leafId?: string; error?: string }>
  navigateBranch: (messageId: string, direction: 'prev' | 'next') => Promise<void>
}

/** Generate a client-proposed message id for server-accepts-client-ID echo reconciliation (GH#14 B6). */
function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `usr-client-${crypto.randomUUID()}`
  }
  return `usr-client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Convert the collection row shape back to the SessionMessage shape consumers expect. */
function toSessionMessage(row: CachedMessage): SessionMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.parts,
    createdAt: row.createdAt
      ? typeof row.createdAt === 'string'
        ? new Date(row.createdAt)
        : row.createdAt
      : undefined,
  } as SessionMessage
}

// ── Session-stream primitives (Spec #38 P1.1) ───────────────────────────
//
// Per-session analogue of `subscribeUserStream` / `onUserStreamReconnect`
// keyed by `sessionId` (the SessionDO's `this.name`, aka the agent name
// used by `useAgent({name: sessionId})`). Handlers are kept outside React
// so collection factories that run at module load can register without
// waiting for the hook to mount. Frame dispatch is driven by the existing
// `useAgent` onMessage handler below; reconnect dispatch rides the
// wsReadyState effect. Mirrors `apps/orchestrator/src/hooks/use-user-stream.ts`
// L174-200 pattern.

type SessionFrameHandler = (frame: SyncedCollectionFrame<unknown>) => void
type SessionReconnectHandler = () => void

const sessionFrameHandlers = new Map<string, Set<SessionFrameHandler>>()
const sessionReconnectHandlers = new Map<string, Set<SessionReconnectHandler>>()

/**
 * Pre-subscribe frame buffer. The messagesCollection's inner sync (which calls
 * `subscribeSessionStream`) is invoked by `persistedCollectionOptions` inside
 * an async IIFE that awaits OPFS startup-metadata load (see
 * `@tanstack/db-sqlite-persistence-core/persisted.ts` L2483-2494 — the inner
 * sync runs one microtask after `await runtime.ensureStartupMetadataLoaded()`).
 * Meanwhile `useAgent({name})` in the same render opens the WS immediately
 * and the DO's onConnect synchronously emits the session's full history as
 * `synced-collection-delta` frames. On session switch the burst races with
 * subscriber registration; without a buffer those frames are silently dropped
 * by `dispatchSessionFrame` and the message list only populates on a later
 * WS reconnect cycle (which re-fires onConnect). Buffer with a 5s TTL so
 * stale frames from a flapping connection don't leak into a later subscriber.
 */
type BufferedFrame = { frame: SyncedCollectionFrame<unknown>; ts: number }
const sessionFrameBuffer = new Map<string, BufferedFrame[]>()
const FRAME_BUFFER_TTL_MS = 5000

/**
 * Subscribe to every SyncedCollectionFrame delivered on `sessionId`'s WS.
 * Does NOT pre-filter by `frame.collection` — consumers (messagesCollection,
 * branchInfoCollection) filter internally. Frames on OTHER sessions' WS do
 * not fire this handler. Returns an unsubscribe fn.
 *
 * On registration, drains any frames that `dispatchSessionFrame` buffered
 * while no subscriber was attached (see `sessionFrameBuffer` above).
 */
export function subscribeSessionStream(
  sessionId: string,
  handler: SessionFrameHandler,
): () => void {
  let set = sessionFrameHandlers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionFrameHandlers.set(sessionId, set)
  }
  set.add(handler)
  const buffered = sessionFrameBuffer.get(sessionId)
  if (buffered && buffered.length > 0) {
    sessionFrameBuffer.delete(sessionId)
    const now = Date.now()
    for (const entry of buffered) {
      if (now - entry.ts > FRAME_BUFFER_TTL_MS) continue
      try {
        handler(entry.frame)
      } catch (err) {
        console.warn('[session-stream] buffered frame handler threw', err)
      }
    }
  }
  return () => {
    const cur = sessionFrameHandlers.get(sessionId)
    if (!cur) return
    cur.delete(handler)
    if (cur.size === 0) sessionFrameHandlers.delete(sessionId)
  }
}

/**
 * Register a callback that fires after `sessionId`'s WS reconnects following
 * a disconnect (not on initial connect). Returns an unsubscribe fn.
 */
export function onSessionStreamReconnect(
  sessionId: string,
  handler: SessionReconnectHandler,
): () => void {
  let set = sessionReconnectHandlers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionReconnectHandlers.set(sessionId, set)
  }
  set.add(handler)
  return () => {
    const cur = sessionReconnectHandlers.get(sessionId)
    if (!cur) return
    cur.delete(handler)
    if (cur.size === 0) sessionReconnectHandlers.delete(sessionId)
  }
}

// Internal dispatch helpers (not exported). Called by the useCodingAgent
// hook's onMessage / reconnect-detection plumbing wired below.
function dispatchSessionFrame(sessionId: string, frame: SyncedCollectionFrame<unknown>): void {
  const set = sessionFrameHandlers.get(sessionId)
  if (!set || set.size === 0) {
    // No subscriber yet — buffer for the late-arriving handler (typically the
    // messagesCollection sync, whose subscribe call is gated behind
    // persistedCollectionOptions' startup-metadata await). See the
    // `sessionFrameBuffer` comment above for the race.
    let q = sessionFrameBuffer.get(sessionId)
    if (!q) {
      q = []
      sessionFrameBuffer.set(sessionId, q)
    }
    const now = Date.now()
    while (q.length > 0 && now - q[0].ts > FRAME_BUFFER_TTL_MS) q.shift()
    q.push({ frame, ts: now })
    return
  }
  for (const h of set) {
    try {
      h(frame)
    } catch (err) {
      console.warn('[session-stream] frame handler threw', err)
    }
  }
}

function dispatchSessionReconnect(sessionId: string): void {
  const set = sessionReconnectHandlers.get(sessionId)
  if (!set || set.size === 0) return
  for (const h of set) {
    try {
      h()
    } catch (err) {
      console.warn('[session-stream] reconnect handler threw', err)
    }
  }
}

/** Test-only reset — clears session-stream registries between tests. */
export function __resetSessionStreamForTests(): void {
  sessionFrameHandlers.clear()
  sessionReconnectHandlers.clear()
  sessionFrameBuffer.clear()
}

/** Test-only dispatch — exercises the internal `dispatchSessionFrame` path. */
export function __dispatchSessionFrameForTests(
  sessionId: string,
  frame: SyncedCollectionFrame<unknown>,
): void {
  dispatchSessionFrame(sessionId, frame)
}

/** Connect to a SessionDO instance by name; returns live state, messages, and RPC helpers. */
export function useCodingAgent(agentName: string): UseCodingAgentResult {
  const prevAgentNameRef = useRef(agentName)

  // Per-agentName collection (memoised inside createMessagesCollection, so the
  // same factory call returns the same instance on re-render).
  const messagesCollection = useMemo(() => createMessagesCollection(agentName), [agentName])

  // Server-authoritative per-session state from `sessionsCollection` (synced
  // collection, DO-backed via `agent_sessions` WS delta frames + D1 REST
  // seed). `contextUsageJson` / `kataStateJson` are TEXT columns in D1; we
  // parse them at read time. Spec #37 P2b B16.
  const session = useSession(agentName)
  const contextUsage = parseJsonField<ContextUsage>(session?.contextUsageJson ?? null)
  const kataState = parseJsonField<KataSessionState>(session?.kataStateJson ?? null)

  // Reset per-session transient state on agentName change (tab switch without
  // remount). Collection rows for other sessions are untouched.
  if (prevAgentNameRef.current !== agentName) {
    prevAgentNameRef.current = agentName
    // branch-info collection is per-agentName (factory memoises); switching
    // sessions auto-swaps the backing collection via `createBranchInfoCollection`.
  }

  // Render source for messages: reactive live query on the persisted collection.
  // `isFetching` proxies the query-collection fetch state and feeds the
  // `isConnecting` derivation below.
  const { messages: cachedMessages, isFetching } = useMessagesCollection(agentName)
  const messages: SessionMessage[] = cachedMessages.map(toSessionMessage)

  // GH#49: on native we MUST pass `query` as a pre-resolved object, not as
  // an async function. `useAgent`'s async-query path (`isAsyncQuery` true)
  // installs an `onClose` handler that calls `setAwaitingQueryRefresh(true)`
  // + `setCacheInvalidatedAt(Date.now())` on every close event. Combined
  // with `useStableSocket`'s `enabled: boolean` dep, the result is a tight
  // feedback loop: close → enabled:false → socket.close() (synthetic close
  // event) → enabled:true → socket.reconnect() (another synthetic close)
  // → close → … — stuck at ~390ms cadence, never opening. The loop
  // reproduces deterministically on Android after a background cycle drops
  // the WS; user-stream + collab are unaffected because they don't use
  // `useAgent`. Resolving the token ONCE at mount and passing it as a
  // plain object takes the async path out of the picture entirely. Token
  // rotation across a live session is rare; on 4401 the server close
  // propagates normally and the app's login redirect handles re-auth.
  const [nativeAuthToken, setNativeAuthToken] = useState<string | null>(null)
  const [nativeAuthTokenResolved, setNativeAuthTokenResolved] = useState(!isNative())
  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    ;(async () => {
      try {
        const { getCapacitorAuthToken } = await import('better-auth-capacitor/client')
        const token = await getCapacitorAuthToken({ storagePrefix: 'better-auth' })
        if (cancelled) return
        setNativeAuthToken(token ?? null)
      } catch {
        // Fall through with null — useAgent will connect without the bearer
        // and the server will reject with 401. That surfaces through the
        // normal auth-redirect path rather than a silent WS thrash.
      } finally {
        if (!cancelled) setNativeAuthTokenResolved(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Spec #31 P5 B10: no DO-side setState broadcast anymore
  // (shouldSendProtocolMessages returns false). The generic is unused for
  // state sync but `useAgent` still requires one — pass `unknown`.
  const connection = useAgent<unknown>({
    agent: 'session-agent',
    name: agentName,
    ...(wsBaseUrl() ? { host: wsBaseUrl() } : {}),
    // Debug: `localStorage['duraclaw.debug.wsHardFail']='1'` + reload freezes
    // the socket on its first close instead of looping through partysocket's
    // infinite auto-reconnect (see ~/lib/ws-debug.ts).
    ...(wsHardFailEnabled() ? { maxRetries: 0 } : {}),
    // Hold the connection closed on native until we've resolved the bearer
    // from Capacitor Preferences — connecting without it would 401-loop.
    enabled: nativeAuthTokenResolved,
    // Capacitor WS can't send cookies cross-origin; pass bearer token as
    // query param so the Worker can inject it as an Authorization header.
    // See GH#49 comment above — this MUST be a plain object, not a fn.
    ...(isNative() && nativeAuthToken ? { query: { _authToken: nativeAuthToken } } : {}),
    // Spec #31 P5 B9: SDK state broadcast suppressed via
    // `shouldSendProtocolMessages() => false` on the DO. The `SessionState`
    // shape is gone and `onStateUpdate` would never fire — omitted.
    onMessage: (message: MessageEvent) => {
      try {
        const parsed = JSON.parse(typeof message.data === 'string' ? message.data : '')

        // Issue #40 Step 0: one line per arriving frame so we can quantify
        // background-streaming continuity. No-op unless localStorage flag
        // `duraclaw.debug.deltaLog` is set to `'1'`.
        if (parsed && typeof parsed === 'object') {
          const kind =
            parsed.type === 'synced-collection-delta' && typeof parsed.collection === 'string'
              ? `synced-collection-delta:${parsed.collection.split(':')[0]}`
              : parsed.type === 'gateway_event' && parsed.event?.type
                ? `gateway_event:${parsed.event.type}`
                : (parsed.type ?? 'unknown')
          logDelta('session', {
            agent: agentName,
            kind,
            seq: typeof parsed.seq === 'number' ? parsed.seq : undefined,
          })
        }

        // Spec #38 P1.1: dispatch SyncedCollectionFrame to per-session
        // handlers (messagesCollection / branchInfoCollection subscribers).
        // The unified `{type:'messages', seq, payload}` wire protocol and
        // its legacy `{type:'messages', messages}` shape are both retired
        // in P1.5 — the DO now emits only `synced-collection-delta` frames
        // for messages and branchInfo (via `broadcastMessages` /
        // `broadcastBranchInfo`).
        if (parsed && parsed.type === 'synced-collection-delta') {
          dispatchSessionFrame(agentName, parsed as SyncedCollectionFrame<unknown>)
          return
        }

        // DO-pushed live status — zero-latency status/gate/error for the
        // active session. Bypasses the D1 round-trip so we never show
        // "idle" while streaming is arriving.
        if (parsed && parsed.type === 'session_status') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const coll = sessionLocalCollection as any
            try {
              coll.update(agentName, (draft: Record<string, unknown>) => {
                draft.liveStatus = parsed.status ?? null
                draft.liveGate = parsed.gate ?? null
                draft.liveError = parsed.error ?? null
              })
            } catch {
              coll.insert({
                id: agentName,
                wsReadyState: 1,
                wsCloseTs: null,
                liveStatus: parsed.status ?? null,
                liveGate: parsed.gate ?? null,
                liveError: parsed.error ?? null,
              })
            }
          } catch {
            // collection not ready
          }
          return
        }

        // Spec #37 P2b B16: the legacy per-turn summary frame handler is
        // retired. The DO now broadcasts per-turn state changes as
        // `agent_sessions` synced deltas (numTurns, totalCostUsd,
        // durationMs, status), which the sessionsCollection applies
        // automatically. No client-side write here.

        // Legacy gateway_event format (non-message events only)
        if (parsed.type === 'gateway_event' && parsed.event) {
          const event = parsed.event as GatewayEvent & { uuid?: string; content?: unknown[] }

          // Spec #37 P2b B16: kata_state / context_usage no longer write to
          // a client collection. The DO persists both into its
          // `agent_sessions` row (as JSON-serialised TEXT columns) and
          // broadcasts a synced delta; sessionsCollection converges.
          // Invalidate the query key so an active queryFn cold-start path
          // refetches the latest TEXT columns — hot path is already
          // synced-delta driven.
          if (event.type === 'kata_state' || event.type === 'context_usage') {
            void queryClient.invalidateQueries({ queryKey: ['sessions'] })
          }

          // Spec 16-chain-ux-p1-5 B6/B7/B9: auto-advance result events.
          if (event.type === 'chain_advance') {
            const issue = (event as { issueNumber?: number }).issueNumber
            const nextMode = (event as { nextMode?: string }).nextMode ?? 'next rung'
            if (typeof issue === 'number') setStallReason(issue, null)
            toast.success(`Auto-advanced to ${nextMode}`, { duration: 3000 })
            void queryClient.invalidateQueries({ queryKey: ['chains'] })
          } else if (event.type === 'chain_stalled') {
            const issue = (event as { issueNumber?: number }).issueNumber
            const reason = (event as { reason?: string }).reason ?? 'Stalled'
            if (typeof issue === 'number') setStallReason(issue, reason)
            void queryClient.invalidateQueries({ queryKey: ['chains'] })
          }

          // Spec #37 B13: `result` gateway_event handler removed — the
          // running → idle transition is now driven by the D1-mirrored
          // `agent_sessions.status` synced-collection delta (written by
          // the DO's syncStatusToD1 + broadcastSessionRow). Cost /
          // duration / numTurns flow on the same row.
        }
      } catch {
        // Ignore non-JSON messages (state sync handled by onStateUpdate)
      }
    },
  })

  // Mirror WS readyState into the live-state collection so components can
  // detect disconnect (B10). `useAgent` returns the raw PartySocket instance
  // whose `readyState` is a mutable property — NOT React state. React only
  // re-renders when useAgent's internal setState fires (CF_AGENT_IDENTITY /
  // CF_AGENT_STATE receipt), but our SessionDO suppresses those protocol
  // messages via `shouldSendProtocolMessages() => false` (Spec #31 P5 B9).
  // Result: after the WS actually opens we never re-render, so the effect
  // dep stays on its initial pre-open value and StatusBar renders
  // "Reconnecting…" forever. Subscribe to the native open/close/error
  // events and mirror readyState through React state so every transition
  // propagates.
  const [readyState, setReadyState] = useState(() => connection.readyState)
  useEffect(() => {
    const sync = () => setReadyState(connection.readyState)
    // Run once in case the socket advanced between render and effect mount.
    sync()
    connection.addEventListener('open', sync)
    connection.addEventListener('close', sync)
    connection.addEventListener('error', sync)
    const detachDebug = attachWsDebug(`session:${agentName}`, connection)
    return () => {
      connection.removeEventListener('open', sync)
      connection.removeEventListener('close', sync)
      connection.removeEventListener('error', sync)
      detachDebug()
    }
  }, [connection, agentName])

  // Spec #38 P1.1: fire `dispatchSessionReconnect(agentName)` on the
  // transition !OPEN → OPEN when we've already seen at least one prior
  // OPEN. Mirrors use-user-stream.ts `hasOpenedOnce` / `hadPriorSocket`
  // semantics so synced-collection subscribers can re-invalidate after a
  // dropped+resumed WS (but not on the initial connect). Reset when
  // `agentName` changes (tab switch without remount) so the fresh
  // session's initial open doesn't look like a reconnect.
  const hasOpenedOnceRef = useRef(false)
  const prevReadyStateRef = useRef<number>(readyState)
  const reconnectAgentNameRef = useRef(agentName)
  if (reconnectAgentNameRef.current !== agentName) {
    reconnectAgentNameRef.current = agentName
    hasOpenedOnceRef.current = false
    prevReadyStateRef.current = readyState
  }
  useEffect(() => {
    const prev = prevReadyStateRef.current
    const OPEN = 1
    if (readyState === OPEN && prev !== OPEN) {
      if (hasOpenedOnceRef.current) {
        dispatchSessionReconnect(agentName)
      }
      hasOpenedOnceRef.current = true
    }
    prevReadyStateRef.current = readyState
  }, [agentName, readyState])

  // Mirror WS readyState into the local-only sessionLocalCollection
  // (Spec #37 B11). Insert on first observation, update on subsequent
  // transitions. On agentName change the effect cleanup leaves the prior
  // row untouched (tab switches preserve per-session state until unmount).
  //
  // GH#69 B5: stamp `wsCloseTs` on OPEN→!OPEN transitions and clear it on
  // !OPEN→OPEN, so `deriveDisplayStateFromStatus` can suppress the
  // DISCONNECTED flash for 5s while ConnectionManager reconnects. We
  // maintain our own ref here rather than reuse `prevReadyStateRef`
  // (which is overwritten by the reconnect-dispatch effect above on the
  // same tick).
  const wsCloseRef = useRef<number>(readyState)
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionLocalCollection as any
    const prev = wsCloseRef.current
    let wsCloseTsPatch: number | null | undefined
    if (prev === 1 && readyState !== 1) {
      wsCloseTsPatch = Date.now()
    } else if (prev !== 1 && readyState === 1) {
      wsCloseTsPatch = null
    } // else: undefined → don't touch existing wsCloseTs
    wsCloseRef.current = readyState
    try {
      // Prefer update; insert on duplicate-key throw (safe both ways).
      try {
        coll.update(
          agentName,
          (draft: {
            wsReadyState: number
            wsCloseTs: number | null
            liveStatus?: unknown
            liveGate?: unknown
            liveError?: unknown
          }) => {
            draft.wsReadyState = readyState
            if (wsCloseTsPatch !== undefined) {
              draft.wsCloseTs = wsCloseTsPatch
            }
            // Clear DO-pushed live status on WS close so display falls
            // back to D1 + TTL predicate for disconnected sessions.
            if (readyState !== 1) {
              draft.liveStatus = null
              draft.liveGate = null
              draft.liveError = null
            }
          },
        )
      } catch {
        coll.insert({
          id: agentName,
          wsReadyState: readyState,
          // On first observation, seed `wsCloseTs` from the transition:
          // if already disconnected, stamp now; if open, null.
          wsCloseTs: readyState === 1 ? null : Date.now(),
        })
      }
    } catch {
      // collection not ready; next readyState change will retry
    }
  }, [agentName, readyState])

  // GH#42: Register this session's PartySocket with the ConnectionManager
  // registry so the global manager (installed in __root.tsx) coordinates
  // reconnect across every client-owned WS on foreground/online events.
  // The adapter reference is stable across renders for a given
  // (connection, agentName) pair — the underlying socket is what
  // `useAgent` returns, which it keeps stable across reconnects, so the
  // adapter is only rebuilt on a genuine socket swap (session change).
  const agentAdapter = useMemo(
    () => createPartySocketAdapter(connection, `agent:${agentName}`),
    [connection, agentName],
  )
  useManagedConnection(agentAdapter, `agent:${agentName}`)

  // On every (re)connect: fire the hydration RPC (D1 init for discovered
  // sessions + VPS gateway transcript catch-up) and send the cursor-aware
  // `subscribe:messages` frame. The RPC is side-effect-only — actual
  // message sync flows back through the WS delta stream that the DO emits
  // in response to the subscribe frame.
  //
  // Why here rather than inside `messagesCollection.sync`: this hook owns
  // the PartySocket and sees its `open` events; the collection's sync fn
  // only sees delta frames and has no handle on the socket. Keeping the
  // subscribe trigger at the socket layer also means it runs on every
  // reconnect, including ones the connection-manager schedules for
  // foreground / online transitions (GH#42).
  useEffect(() => {
    const onOpen = () => {
      connection.call('getMessages', []).catch(() => {
        // Side-effect RPC; return value intentionally ignored.
      })
      try {
        const sinceCursor = computeTailCursor(messagesCollection)
        connection.send(JSON.stringify({ type: 'subscribe:messages', sinceCursor }))
      } catch {
        // computeTailCursor is defensive; any throw falls back to a
        // cold-load subscribe so the client still receives history.
        connection.send(JSON.stringify({ type: 'subscribe:messages', sinceCursor: null }))
      }
    }
    agentAdapter.addEventListener('open', onOpen)
    return () => agentAdapter.removeEventListener('open', onOpen)
  }, [agentAdapter, connection, messagesCollection])

  const spawn = useCallback(
    (config: SpawnConfig) => connection.call('spawn', [config]),
    [connection],
  )
  const stop = useCallback((reason?: string) => connection.call('stop', [reason]), [connection])
  const abort = useCallback((reason?: string) => connection.call('abort', [reason]), [connection])
  const forceStop = useCallback(
    (reason?: string) => connection.call('forceStop', [reason]),
    [connection],
  )
  const interrupt = useCallback(() => connection.call('interrupt', []), [connection])
  const getContextUsage = useCallback(() => connection.call('getContextUsage', []), [connection])
  const reattach = useCallback(() => connection.call('reattach', []), [connection])
  const resumeFromTranscript = useCallback(
    () => connection.call('resumeFromTranscript', []),
    [connection],
  )
  /**
   * Resolve a pending gate.
   *
   * Bug #63 B: optimistically flip the gate part's state to
   * `output-available` + stamp the local `output` so the GateResolver
   * collapses into the resolved Q/A block immediately, rather than
   * waiting for the server echo. The server's canonical row reconciles
   * via the messagesCollection synced-delta path on success; on RPC
   * failure we re-assert the pre-mutation part so the user can retry.
   *
   * Output shape mirrors the server's `resolveGate` storage (see
   * session-do `resolveGate`):
   *   - structured ask_user: `{ answers: StructuredAnswer[] }` (object)
   *   - legacy flat ask_user: `response.answer` (string)
   *   - permission: `'Approved'` / `'Declined'` (string)
   */
  const resolveGate = useCallback(
    async (gateId: string, response: GateResponse) => {
      // Find the target message + the mutated parts array. TanStack DB's
      // native optimistic path (createTransaction + tx.mutate) needs the
      // message id to call `collection.update` against, and the new parts
      // to stage. We iterate the live collection because a gate can live
      // in any assistant message — not necessarily the latest one.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coll = messagesCollection as any
      let targetMsgId: string | undefined
      let nextParts: SessionMessagePart[] | undefined
      try {
        for (const [id, row] of coll as Iterable<[string, CachedMessage]>) {
          const parts = row.parts ?? []
          const idx = parts.findIndex(
            (p) =>
              p.toolCallId === gateId &&
              // Match both pending shapes: `approval-requested` is the
              // DO-promoted (tool-ask_user / tool-permission) shape;
              // `input-available` is the SDK-native
              // (tool-AskUserQuestion) shape the client now renders
              // directly. Without both, the optimistic write is skipped
              // for native-shape gates.
              (p.state === 'approval-requested' || p.state === 'input-available'),
          )
          if (idx >= 0) {
            targetMsgId = id
            nextParts = parts.map((p, i) =>
              i === idx ? { ...p, state: 'output-available' as const, output: undefined } : p,
            )
            break
          }
        }
      } catch {
        // collection not iterable yet — skip optimistic write entirely.
      }

      const optimisticOutput: unknown = Array.isArray(response.answers)
        ? { answers: response.answers }
        : typeof response.answer === 'string'
          ? response.answer
          : typeof response.approved === 'boolean'
            ? response.approved
              ? 'Approved'
              : 'Declined'
            : undefined

      // Stamp the computed output onto the mutated part now that we know
      // the response shape. Kept out of the findIndex loop so the
      // response-type switch only runs once.
      if (nextParts && optimisticOutput !== undefined) {
        nextParts = nextParts.map((p) =>
          p.toolCallId === gateId ? { ...p, output: optimisticOutput } : p,
        )
      }

      // Native TanStack DB optimistic path: createTransaction runs the
      // async `mutationFn` (the RPC) and keeps the tx.mutate staged write
      // visible to `useLiveQuery` readers as an optimistic layer merged
      // *over* synced. Any WS delta that arrives for this row during the
      // RPC window writes to synced — it does NOT overwrite the rendered
      // view, so the UI stays on the resolved summary instead of flashing
      // back to the pre-submit gate. On success, server echo reconciles
      // via deepEquals; on mutationFn throw, the staged write auto-rolls
      // back and the GateResolver re-mounts for retry.
      //
      // If we couldn't locate the target row (cold cache, row churn), we
      // still fire the RPC — the server-side resolveGate broadcast will
      // reconcile the state as soon as it lands.
      if (targetMsgId && nextParts) {
        const stagedParts = nextParts
        const stagedId = targetMsgId
        const tx = createTransaction<CachedMessage & Record<string, unknown>>({
          mutationFn: async () => {
            const result = (await connection.call('resolveGate', [gateId, response])) as {
              ok?: boolean
              error?: string
            }
            if (!result || result.ok !== true) {
              throw new Error(result?.error ?? 'resolveGate failed')
            }
            return result
          },
        })
        tx.mutate(() => {
          coll.update(stagedId, (draft: CachedMessage) => {
            draft.parts = stagedParts
          })
        })
        try {
          await tx.isPersisted.promise
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      // Fallback: no matching pending part found in the live collection
      // — fire the RPC directly and let the server echo drive the UI.
      const result = (await connection.call('resolveGate', [gateId, response])) as {
        ok?: boolean
        error?: string
      }
      return result
    },
    [connection, messagesCollection],
  )

  // Return the live WS readyState rather than a state-presence proxy: once
  // `state` arrives and the socket later closes we want consumers to see the
  // real transition (0 connecting, 1 open, 2 closing, 3 closed). Reads the
  // state mirror above so downstream consumers re-render on open/close.
  const wsReadyState = readyState
  const isConnecting = isFetching || wsReadyState !== 1

  const rewind = useCallback(
    async (turnIndex: number) => {
      // DO broadcasts a pair of synced-collection deltas (messages +
      // branchInfo) in the same DO turn. The messages / branchInfo
      // collection subscriptions converge the view; no client-side replace.
      return (await connection.call('rewind', [turnIndex])) as {
        ok: boolean
        error?: string
      }
    },
    [connection],
  )

  const resubmitMessage = useCallback(
    async (messageId: string, content: string) => {
      // The DO's `resubmitMessage` path emits sibling synced-collection
      // deltas on the messages and branchInfo wires in the same DO turn
      // (GH#38 P1.5). The collection subscriptions reconcile both views
      // server-side — the client only fires the RPC and awaits the frames.
      return (await connection.call('resubmitMessage', [messageId, content])) as {
        ok: boolean
        leafId?: string
        error?: string
      }
    },
    [connection],
  )

  const navigateBranch = useCallback(
    async (messageId: string, direction: 'prev' | 'next') => {
      // `messageId` is the currently-rendered user-turn id (ChatThread
      // passes `msg.id`). Find its row by matching `activeId` so we can
      // compute the next/prev sibling id to request.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const biColl = createBranchInfoCollection(agentName) as any
      let row: BranchInfoRow | undefined
      try {
        for (const [, r] of biColl as Iterable<[string, BranchInfoRow]>) {
          if (r.activeId === messageId) {
            row = r
            break
          }
        }
      } catch {
        // collection not ready
      }
      if (!row) return
      const idx = row.siblings.indexOf(row.activeId)
      if (idx < 0) return
      const targetId = direction === 'next' ? row.siblings[idx + 1] : row.siblings[idx - 1]
      if (!targetId) return
      // DO responds with a reason='branch-navigate' snapshot carrying both
      // the target branch's history AND updated branchInfo rows. The
      // collection subscriptions converge the view from the pushed frame.
      try {
        await connection.call('getBranchHistory', [targetId])
      } catch {
        // Non-fatal: the client stays on the current branch.
      }
    },
    [connection, agentName],
  )

  /**
   * Send a user turn.
   *
   * GH#38 P1.3 string path — `messagesCollection.insert(optimisticRow)`
   * goes through the synced-collection factory's `onInsert` handler which
   * POSTs `/api/sessions/:id/messages` with `{content, clientId, createdAt}`.
   * Server adopts `clientId` as the row's primary id and `createdAt`
   * verbatim so the WS echo reconciles in place via TanStack DB's
   * `deepEquals` (B7/B14) — no manual writeUpsert/writeDelete. If the
   * factory's onInsert throws, TanStack DB rolls back the optimistic row
   * automatically.
   *
   * Image / ContentBlock[] sends stay on the legacy `connection.call
   * ('sendMessage')` RPC path — the factory's onInsert only handles
   * plain-text content (spec #38 non-goal: migrating image ingest).
   */
  const sendMessage = useCallback(
    async (content: string | ContentBlock[], opts?: { submitId?: string }) => {
      const clientMessageId = newClientMessageId()

      // String path — route through messagesCollection.insert so the
      // factory's onInsert owns the REST POST. Loopback reconciliation via
      // deepEquals keeps the optimistic row stable across the echo.
      if (typeof content === 'string') {
        const optimisticRow: CachedMessage = {
          id: clientMessageId,
          sessionId: agentName,
          role: 'user',
          parts: contentToParts(content),
          // ISO string (not Date) keeps optimistic row shape byte-identical
          // with the server echo — POST carries the same string forward
          // and the server adopts it verbatim.
          createdAt: new Date().toISOString(),
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tx = (messagesCollection as any).insert(optimisticRow)
          await tx.isPersisted.promise
          return { ok: true }
        } catch (err) {
          // TanStack DB rolls back the optimistic row automatically when
          // the mutationFn (factory onInsert) throws.
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }

      // ContentBlock[] (image) path — keep the legacy RPC-based optimistic
      // write. Factory onInsert doesn't handle image content; spec defers
      // migration.
      const optimisticRow: CachedMessage = {
        id: clientMessageId,
        sessionId: agentName,
        role: 'user',
        parts: contentToParts(content),
        createdAt: new Date(),
      }
      try {
        messagesCollection.utils.writeUpsert(optimisticRow)
      } catch {
        // writeUpsert is best-effort; if it throws, fall through to the RPC.
      }
      try {
        const result = (await connection.call('sendMessage', [
          content,
          { ...opts, client_message_id: clientMessageId },
        ])) as { ok: boolean; error?: string; recoverable?: string }
        if (!result.ok) {
          throw new Error(result.error ?? 'sendMessage failed')
        }
        return { ok: true }
      } catch (err) {
        // Roll back the optimistic row so a failed send doesn't linger.
        try {
          messagesCollection.utils.writeDelete(clientMessageId)
        } catch {
          // If the echo already landed and upgraded the row, writeDelete
          // may no-op; the next snapshot reconciles.
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    [agentName, connection, messagesCollection],
  )

  /** Draft submit: optimistically clear a shared Y.Text, send, restore on failure. */
  const submitDraft = useCallback(
    async (yText: Y.Text) => {
      const text = yText.toString()
      if (text.length === 0) return { ok: true, sent: false }
      const doc = yText.doc
      // Snapshot + optimistic clear; restore no-ops if peers have typed since.
      const clear = () => {
        const len = yText.length
        if (len > 0) yText.delete(0, len)
      }
      const restore = () => {
        if (yText.length === 0) yText.insert(0, text)
      }
      const runRestore = () => (doc ? doc.transact(restore) : restore())
      if (doc) doc.transact(clear)
      else clear()

      // Dev-only VP2 hook: simulate send failure e2e without mocking the WS.
      const viteEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env
      const mockFailure =
        viteEnv?.DEV === true &&
        typeof window !== 'undefined' &&
        (window as unknown as { __mockSendFailure?: boolean }).__mockSendFailure === true

      if (mockFailure) {
        runRestore()
        return { ok: false, sent: false, error: 'mock failure' }
      }

      const clientMessageId = newClientMessageId()
      const optimisticRow: CachedMessage & Record<string, unknown> = {
        id: clientMessageId,
        sessionId: agentName,
        role: 'user',
        parts: contentToParts(text),
        // ISO string (not Date) — server adopts verbatim, deepEquals
        // reconciles in place on echo.
        createdAt: new Date().toISOString(),
      }
      // GH#38 P1.3: route through the factory's onInsert (which POSTs
      // /api/sessions/:id/messages with {content, clientId, createdAt}).
      // TanStack DB's collection.insert returns a Transaction; awaiting
      // `isPersisted.promise` waits for the mutationFn to settle. On
      // throw, the optimistic row rolls back automatically and we
      // restore the Y.Text draft.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx = (messagesCollection as any).insert(optimisticRow)
        await tx.isPersisted.promise
        return { ok: true, sent: true }
      } catch (err) {
        runRestore()
        return {
          ok: false,
          sent: false,
          error: err instanceof Error ? err.message : 'send failed',
        }
      }
    },
    [agentName, messagesCollection],
  )

  const forkWithHistory = useCallback(
    async (content: string | ContentBlock[]) => {
      const clientMessageId = newClientMessageId()
      const optimisticRow: CachedMessage & Record<string, unknown> = {
        id: clientMessageId,
        sessionId: agentName,
        role: 'user',
        parts: contentToParts(content),
        createdAt: new Date(),
      }
      const tx = createTransaction<CachedMessage & Record<string, unknown>>({
        mutationFn: async () => {
          // NB: DO-side forkWithHistory does not currently accept
          // client_message_id (the DO-authored user row carries its own
          // `usr-N` id). The optimistic row stays keyed on
          // `usr-client-<uuid>`; the server echo arrives with a different id
          // but the snapshot emitted by forkWithHistory reconciles via
          // the messagesCollection synced-delta path and still converges.
          // Documented as a deviation in GH#14 P3.
          const result = (await connection.call('forkWithHistory', [content])) as {
            ok: boolean
            error?: string
          }
          if (!result.ok) {
            throw new Error(result.error ?? 'forkWithHistory failed')
          }
          return result
        },
      })
      tx.mutate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(messagesCollection as any).insert(optimisticRow)
      })
      try {
        await tx.isPersisted.promise
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    [agentName, connection, messagesCollection],
  )

  return {
    messages,
    kataState,
    contextUsage,
    wsReadyState,
    isConnecting,
    spawn,
    stop,
    abort,
    forceStop,
    interrupt,
    getContextUsage,
    resolveGate,
    sendMessage,
    submitDraft,
    forkWithHistory,
    reattach,
    resumeFromTranscript,
    rewind,
    resubmitMessage,
    navigateBranch,
  }
}
