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
import type * as Y from 'yjs'
import { type BranchInfoRow, createBranchInfoCollection } from '~/db/branch-info-collection'
import { queryClient } from '~/db/db-instance'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'
import { sessionLocalCollection } from '~/db/session-local-collection'
import { useMessagesCollection } from '~/hooks/use-messages-collection'
import { useSession } from '~/hooks/use-sessions-collection'
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
  SpawnConfig,
} from '~/lib/types'
import { attachWsDebug, wsHardFailEnabled } from '~/lib/ws-debug'
import { useAppLifecycle } from './use-app-lifecycle'

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
  rewind: (turnIndex: number) => Promise<{ ok: boolean; error?: string }>
  injectQaPair: (question: string, answer: string) => void
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
 * Subscribe to every SyncedCollectionFrame delivered on `sessionId`'s WS.
 * Does NOT pre-filter by `frame.collection` — consumers (messagesCollection,
 * branchInfoCollection) filter internally. Frames on OTHER sessions' WS do
 * not fire this handler. Returns an unsubscribe fn.
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
  if (!set || set.size === 0) return
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
    // Capacitor WS can't send cookies cross-origin; pass bearer token as
    // query param so the Worker can inject it as an Authorization header.
    ...(isNative()
      ? {
          query: async (): Promise<Record<string, string | null>> => {
            const { getCapacitorAuthToken } = await import('better-auth-capacitor/client')
            const token = await getCapacitorAuthToken({ storagePrefix: 'better-auth' })
            return token ? { _authToken: token } : {}
          },
          queryDeps: [],
        }
      : {}),
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
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionLocalCollection as any
    try {
      // Prefer update; insert on duplicate-key throw (safe both ways).
      try {
        coll.update(agentName, (draft: { wsReadyState: number }) => {
          draft.wsReadyState = readyState
        })
      } catch {
        coll.insert({ id: agentName, wsReadyState: readyState })
      }
    } catch {
      // collection not ready; next readyState change will retry
    }
  }, [agentName, readyState])

  // Capacitor only: on foreground / network-change, force both the
  // per-session WS and the singleton user-stream WS to reconnect (defeats
  // zombie sockets — see use-app-lifecycle.ts for the rationale), then
  // hydrate missed messages. No-op on web.
  useAppLifecycle({
    hydrate: useCallback(() => {
      connection.call('getMessages', []).catch(() => {
        // Best-effort hydrate; messages collection still falls back to
        // its queryFn for cold-start / stale-cache.
      })
    }, [connection]),
    reconnect: useCallback(() => {
      try {
        connection.reconnect()
      } catch {
        // ignore — socket may already be tearing down
      }
    }, [connection]),
  })

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
  const resolveGate = useCallback(
    (gateId: string, response: GateResponse) => connection.call('resolveGate', [gateId, response]),
    [connection],
  )

  const injectQaPair = useCallback(
    (question: string, answer: string) => {
      try {
        messagesCollection.insert({
          id: `qa-${Date.now()}`,
          sessionId: agentName,
          role: 'qa_pair',
          parts: [{ type: 'text', text: `Q: ${question}\nA: ${answer}` }],
        } as CachedMessage & Record<string, unknown>)
      } catch {
        // duplicate id or collection not ready — drop
      }
    },
    [agentName, messagesCollection],
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
    rewind,
    injectQaPair,
    resubmitMessage,
    navigateBranch,
  }
}
