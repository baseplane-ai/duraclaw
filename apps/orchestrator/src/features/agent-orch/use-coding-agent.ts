/**
 * Hook for connecting to a SessionDO via the agents/react useAgent hook.
 *
 * Render source for the message list is `messagesCollection` (OPFS-persisted)
 * via `useMessagesCollection`; server-authoritative live state (status,
 * context usage, kata, session result) is read from `sessionLiveStateCollection`
 * via `useSessionLiveState`. Per-turn branch info is a reactive read from
 * `branchInfoCollection` via `useBranchInfo` — DO-pushed on snapshot
 * payloads (B7). WS handlers below write into those collections on state /
 * gateway-event / messages-frame delivery.
 */

import { createTransaction } from '@tanstack/db'
import { useAgent } from 'agents/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type * as Y from 'yjs'
import { type BranchInfoRow, createBranchInfoCollection } from '~/db/branch-info-collection'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'
import { upsertSessionLiveState } from '~/db/session-live-state-collection'
import { useMessagesCollection } from '~/hooks/use-messages-collection'
import { useSessionLiveState } from '~/hooks/use-session-live-state'
import { contentToParts } from '~/lib/message-parts'
import { isNative, wsBaseUrl } from '~/lib/platform'
import type {
  ContentBlock,
  ContextUsage,
  GateResponse,
  KataSessionState,
  SessionMessage,
  SpawnConfig,
} from '~/lib/types'
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

/**
 * Stamp a SessionMessage with its sessionId (and optionally wire seq) for
 * the collection row. Spec-31 P4a B8: delta handlers pass `frame.seq`;
 * snapshot handlers pass `frame.payload.version`. Optimistic and cold-start
 * rows omit seq — those rows sort last within their group by tuple
 * `[seq ?? Infinity, turnOrdinal ?? Infinity, createdAt]`.
 */
function toRow(
  msg: SessionMessage,
  sessionId: string,
  seq?: number,
): CachedMessage & Record<string, unknown> {
  return {
    id: msg.id,
    sessionId,
    role: msg.role,
    parts: msg.parts,
    createdAt: msg.createdAt,
    ...(seq !== undefined ? { seq } : {}),
  } as CachedMessage & Record<string, unknown>
}

/** Connect to a SessionDO instance by name; returns live state, messages, and RPC helpers. */
export function useCodingAgent(agentName: string): UseCodingAgentResult {
  const prevAgentNameRef = useRef(agentName)
  // Per-session watermark for MessagesFrame `seq` (B1/B3). Keyed by agentName
  // so concurrent session tabs each keep their own highest-applied seq.
  const lastSeqRef = useRef<Map<string, number>>(new Map())

  // Per-agentName collection (memoised inside createMessagesCollection, so the
  // same factory call returns the same instance on re-render).
  const messagesCollection = useMemo(() => createMessagesCollection(agentName), [agentName])

  // Server-authoritative live state from the TanStack DB collection.
  // Spec #31 P5 B10: `state` / `sessionResult` narrowed off. Status / gate
  // / result come from `useDerivedStatus` / `useDerivedGate` over
  // `messagesCollection`; `contextUsage` / `kataState` remain on the
  // live-state collection.
  const { contextUsage, kataState } = useSessionLiveState(agentName)

  // Reset per-session transient state on agentName change (tab switch without
  // remount). Collection rows for other sessions are untouched.
  if (prevAgentNameRef.current !== agentName) {
    lastSeqRef.current.delete(prevAgentNameRef.current)
    prevAgentNameRef.current = agentName
    // branch-info collection is per-agentName (factory memoises); switching
    // sessions auto-swaps the backing collection via `createBranchInfoCollection`.
  }

  // Render source for messages: reactive live query on the persisted collection.
  // `isFetching` proxies the query-collection fetch state and feeds the
  // `isConnecting` derivation below.
  const { messages: cachedMessages, isFetching } = useMessagesCollection(agentName)
  const messages: SessionMessage[] = cachedMessages.map(toSessionMessage)

  /**
   * Bulk-upsert SessionMessages into the collection via the sync-write API.
   *
   * `collection.insert/update/delete` create *optimistic* mutations on a
   * separate state layer — those are for user-initiated writes that round-trip
   * through `onInsert/onUpdate/onDelete` handlers. WS-pushed writes ARE the
   * server's authoritative state; they must go through `utils.writeUpsert`
   * (and `writeDelete` / `writeBatch`) which writes directly to the
   * collection's synced data store — the layer IVM / `useLiveQuery` reads
   * from. See planning/research/2026-04-20-streamdb-pattern-adoption.md.
   */
  const bulkUpsert = useCallback(
    (msgs: SessionMessage[], seq?: number) => {
      try {
        messagesCollection.utils.writeBatch(() => {
          for (const m of msgs) messagesCollection.utils.writeUpsert(toRow(m, agentName, seq))
        })
      } catch {
        // Rare mutation-API contention; next event will retry.
      }
    },
    [agentName, messagesCollection],
  )

  /**
   * Snapshot reconcile: delete rows for this session not in `messages`, then
   * upsert. Spec-31 P4a B8: every row gets stamped with `seq` (the
   * snapshot's `payload.version`). Rows within the snapshot tie on seq and
   * fall through to the `turnOrdinal → createdAt` secondary — correct,
   * since the snapshot's history was already ordered at emit time.
   */
  const applySnapshot = useCallback(
    (messages: SessionMessage[], seq?: number) => {
      const newIds = new Set(messages.map((m) => m.id))
      const staleIds: string[] = []
      try {
        for (const [id, row] of messagesCollection as Iterable<[string, CachedMessage]>) {
          if (row.sessionId === agentName && !newIds.has(id)) staleIds.push(id)
        }
      } catch {}
      // writeDelete throws if the key isn't in syncedData (e.g., an optimistic-
      // only row from an in-flight user transaction). Skip those — the owning
      // transaction will settle and the next delta will reconcile.
      for (const id of staleIds) {
        try {
          messagesCollection.utils.writeDelete(id)
        } catch {}
      }
      bulkUpsert(messages, seq)
    },
    [bulkUpsert, messagesCollection, agentName],
  )

  /**
   * Apply a `{type:'messages', seq, payload}` frame from the DO (B1/B3).
   *
   * Rules:
   *   - `snapshot`: always apply regardless of seq, and bump the watermark to
   *     `max(lastSeq, payload.version)` so subsequent in-flight deltas that
   *     predated the snapshot (seq <= version) are dropped as stale.
   *   - `delta` with seq === lastSeq + 1: contiguous, apply upserts + removes
   *     and advance watermark.
   *   - `delta` with seq > lastSeq + 1: gap — invoke `onGap` (caller requests
   *     a snapshot). Do NOT apply and do NOT advance seq.
   *   - `delta` with seq <= lastSeq: stale/duplicate — drop.
   *
   * The `onGap` callback is supplied by `onMessage` because `connection` is
   * created below this hook; passing it in keeps this callback's deps stable.
   */
  const handleMessagesFrame = useCallback(
    (
      frame: {
        type: 'messages'
        sessionId: string
        seq: number
        payload:
          | {
              kind: 'delta'
              upsert?: SessionMessage[]
              remove?: string[]
              branchInfo?: { upsert?: BranchInfoRow[]; remove?: string[] }
            }
          | {
              kind: 'snapshot'
              version: number
              messages: SessionMessage[]
              reason: string
            }
      },
      onGap: () => void,
    ) => {
      const map = lastSeqRef.current
      const lastSeq = map.get(agentName) ?? 0

      if (frame.payload.kind === 'snapshot') {
        applySnapshot(frame.payload.messages, frame.payload.version)
        // Reset lastSeq to the snapshot's version unconditionally. The old
        // `Math.max(lastSeq, version)` prevented the client from accepting a
        // lower version after a DO rehydrate (messageSeq resets to 0 in-memory
        // — issue #25). That caused every subsequent delta with seq <= lastSeq
        // to be silently dropped as stale, breaking streaming entirely.
        map.set(agentName, frame.payload.version)
        // B7: DO pushes branchInfo alongside snapshot payloads on reconnect,
        // rewind, resubmit, and branch-navigate. Upsert each row into the
        // per-session branchInfoCollection; the `useBranchInfo` hook reads
        // reactively.
        const branchInfo = (frame.payload as { branchInfo?: BranchInfoRow[] }).branchInfo
        if (branchInfo && branchInfo.length > 0) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const biColl = createBranchInfoCollection(agentName) as any
            for (const row of branchInfo) {
              try {
                if (biColl.has?.(row.parentMsgId)) {
                  biColl.update(row.parentMsgId, (draft: BranchInfoRow) => {
                    Object.assign(draft, row)
                  })
                } else {
                  biColl.insert(row)
                }
              } catch {
                // ignore — next snapshot retries
              }
            }
          } catch {
            // collection may not be ready; next snapshot retries
          }
        }
        return
      }

      // kind === 'delta'
      if (frame.seq === lastSeq + 1) {
        const upsertList = frame.payload.upsert ?? []
        const removeList = frame.payload.remove ?? []
        // GH#14 P3: user echoes reconcile via id match alone. The DO accepts
        // the client-proposed `client_message_id` as the primary id, so
        // TanStack DB deep-equality retires the optimistic row silently.
        try {
          messagesCollection.utils.writeBatch(() => {
            for (const m of upsertList) {
              // Spec-31 P4a B8: stamp delta rows with `frame.seq` so the
              // messages-collection sort orders by wire arrival order.
              messagesCollection.utils.writeUpsert(toRow(m, agentName, frame.seq))
            }
            if (removeList.length > 0) {
              messagesCollection.utils.writeDelete(removeList)
            }
          })
        } catch {
          // swallow — next frame will reconcile
        }
        // P2 B2: deltas can piggyback branchInfo when a user-turn mutation
        // changes a parent's sibling list. Apply upserts/removes into the
        // per-session branchInfoCollection — same pattern as snapshot payloads.
        const deltaBranchInfo = (
          frame.payload as {
            branchInfo?: { upsert?: BranchInfoRow[]; remove?: string[] }
          }
        ).branchInfo
        if (deltaBranchInfo) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const biColl = createBranchInfoCollection(agentName) as any
            if (deltaBranchInfo.upsert && deltaBranchInfo.upsert.length > 0) {
              for (const row of deltaBranchInfo.upsert) {
                try {
                  if (biColl.has?.(row.parentMsgId)) {
                    biColl.update(row.parentMsgId, (draft: BranchInfoRow) => {
                      Object.assign(draft, row)
                    })
                  } else {
                    biColl.insert(row)
                  }
                } catch {
                  // ignore — next snapshot retries
                }
              }
            }
            if (deltaBranchInfo.remove && deltaBranchInfo.remove.length > 0) {
              for (const id of deltaBranchInfo.remove) {
                try {
                  biColl.delete?.(id)
                } catch {
                  // ignore — next snapshot retries
                }
              }
            }
          } catch {
            // collection may not be ready; next snapshot retries
          }
        }
        map.set(agentName, frame.seq)
        return
      }

      if (frame.seq > lastSeq + 1) {
        // True gap — request snapshot; do NOT apply delta or advance seq.
        onGap()
        return
      }

      // frame.seq <= lastSeq — stale/duplicate; drop silently.
      return
    },
    [agentName, applySnapshot, messagesCollection],
  )

  // Spec #31 P5 B10: no DO-side setState broadcast anymore
  // (shouldSendProtocolMessages returns false). The generic is unused for
  // state sync but `useAgent` still requires one — pass `unknown`.
  const connection = useAgent<unknown>({
    agent: 'session-agent',
    name: agentName,
    ...(wsBaseUrl() ? { host: wsBaseUrl() } : {}),
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

        // Unified {type:'messages'} frame (B1/B3). Supports the new
        // `{seq, payload}` shape with gap detection, and (for deploy
        // rollover safety) still tolerates the legacy `{messages}` shape
        // in case an old DO build emits it during the window.
        if (parsed.type === 'messages') {
          if (
            typeof parsed.seq === 'number' &&
            parsed.payload &&
            typeof parsed.payload.kind === 'string'
          ) {
            const frame = parsed as {
              type: 'messages'
              sessionId: string
              seq: number
              payload:
                | {
                    kind: 'delta'
                    upsert?: SessionMessage[]
                    remove?: string[]
                    branchInfo?: { upsert?: BranchInfoRow[]; remove?: string[] }
                  }
                | {
                    kind: 'snapshot'
                    version: number
                    messages: SessionMessage[]
                    reason: string
                  }
            }
            handleMessagesFrame(frame, () => {
              connection.call('requestSnapshot', []).catch(() => {
                // Non-critical; reconnect path will eventually resync.
              })
            })
            return
          }
          // Legacy shape: {type:'messages', messages: SessionMessage[]}
          if (Array.isArray((parsed as { messages?: unknown }).messages)) {
            applySnapshot((parsed as { messages: SessionMessage[] }).messages)
            return
          }
          return
        }

        // Legacy gateway_event format (non-message events only)
        if (parsed.type === 'gateway_event' && parsed.event) {
          const event = parsed.event as GatewayEvent & { uuid?: string; content?: unknown[] }

          // Capture kata session state
          if (event.type === 'kata_state') {
            const kataState = (event as unknown as { kata_state: KataSessionState }).kata_state
            upsertSessionLiveState(agentName, { kataState })
          }

          // Capture context usage from get-context-usage response
          if (event.type === 'context_usage') {
            const usage = (event as unknown as { usage: Record<string, unknown> }).usage
            const contextUsage: ContextUsage = {
              totalTokens: (usage.totalTokens as number) ?? 0,
              maxTokens: (usage.maxTokens as number) ?? 0,
              percentage: (usage.percentage as number) ?? 0,
              model: usage.model as string | undefined,
              isAutoCompactEnabled: usage.isAutoCompactEnabled as boolean | undefined,
              autoCompactThreshold: usage.autoCompactThreshold as number | undefined,
            }
            upsertSessionLiveState(agentName, { contextUsage })
          }

          // Spec-31 P4b B3: `result` gateway_event handler removed — the
          // running → idle transition is now driven by `useDerivedStatus`
          // reading the final persisted message, and cost/duration are
          // surfaced via the D1 REST endpoint for non-active callers.
          // `sessionResult` stops being written here; `sessionLiveStateCollection`
          // narrowing to drop the field happens in P5.
        }
      } catch {
        // Ignore non-JSON messages (state sync handled by onStateUpdate)
      }
    },
  })

  // Mirror WS readyState into the live-state collection so components can
  // detect disconnect (B10). Observes every transition including reconnects.
  useEffect(() => {
    upsertSessionLiveState(agentName, { wsReadyState: connection.readyState })
  }, [agentName, connection.readyState])

  // Capacitor only: hydrate missed messages on foreground. The WS itself
  // is left alone — partysocket auto-reconnects if Android killed it while
  // backgrounded. No-op on web.
  useAppLifecycle({
    hydrate: useCallback(() => {
      connection.call('getMessages', []).catch(() => {
        // Best-effort hydrate; messages collection still falls back to
        // its queryFn for cold-start / stale-cache.
      })
    }, [connection]),
  })

  const spawn = useCallback(
    (config: SpawnConfig) => connection.call('spawn', [config]),
    [connection],
  )
  const stop = useCallback((reason?: string) => connection.call('stop', [reason]), [connection])
  const abort = useCallback((reason?: string) => connection.call('abort', [reason]), [connection])
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
  // real transition (0 connecting, 1 open, 2 closing, 3 closed).
  const wsReadyState = connection.readyState
  const isConnecting = isFetching || wsReadyState !== 1

  const rewind = useCallback(
    async (turnIndex: number) => {
      // DO broadcasts a reason='rewind' snapshot (B2) that reconciles via
      // the normal handleMessagesFrame path — no client-side replace.
      return (await connection.call('rewind', [turnIndex])) as {
        ok: boolean
        error?: string
      }
    },
    [connection],
  )

  const resubmitMessage = useCallback(
    async (messageId: string, content: string) => {
      // The DO's `resubmitMessage` path emits a reason='resubmit' snapshot
      // (B2) carrying both the new leaf's history AND the parent's fresh
      // branchInfo row (B7). The snapshot handler in `handleMessagesFrame`
      // reconciles both collections server-side — the client only fires the
      // RPC and awaits the pushed snapshot frame.
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
   * GH#14 P3 + 2026-04-20 send-flash fix: optimistic user-row inserts bypass
   * TanStack DB's optimistic overlay entirely and write directly into the
   * synced layer via `utils.writeUpsert`. The server echo arrives as a
   * regular delta frame and `writeUpsert`s the same id in place — no
   * transaction state machine to fight.
   *
   * Why bypass the optimistic overlay: the overlay's "redundant sync" fast
   * path requires `deepEquals(optimisticRow, syncedRow)` to pass, and it
   * doesn't — the server echo has `seq` (stamped from `frame.seq`), a
   * server-regenerated `createdAt`, and `canonical_turn_id`. When the
   * RPC reply's microtask runs before the broadcast-delta WS event is
   * dispatched, `recomputeOptimisticState` finds no pending synced tx for
   * the client id, evicts the optimistic row as stale, and the row
   * briefly disappears until the delta lands. Writing direct to syncedData
   * sidesteps the race entirely.
   *
   * Rollback on RPC error: `writeDelete` the optimistic id. If the tab
   * reconnects mid-flight and the server never saw the send, the next
   * snapshot reconciles away the ghost row either way.
   */
  const sendMessage = useCallback(
    async (content: string | ContentBlock[], opts?: { submitId?: string }) => {
      const clientMessageId = newClientMessageId()
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

      const submitId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

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
        createdAt: new Date(),
      }
      const tx = createTransaction<CachedMessage & Record<string, unknown>>({
        mutationFn: async () => {
          const result = (await connection.call('sendMessage', [
            text,
            { submitId, client_message_id: clientMessageId },
          ])) as { ok: boolean; error?: string }
          if (!result.ok) {
            throw new Error(result.error ?? 'sendMessage failed')
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
    [agentName, connection, messagesCollection],
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
          // handleMessagesFrame and still converges the collection.
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
