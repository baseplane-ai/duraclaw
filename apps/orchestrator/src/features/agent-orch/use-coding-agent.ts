/**
 * Hook for connecting to a SessionDO via the agents/react useAgent hook.
 *
 * Render source for the message list is `messagesCollection` (OPFS-persisted)
 * via `useMessagesCollection`; server-authoritative live state (status,
 * context usage, kata, session result) is read from `sessionLiveStateCollection`
 * via `useSessionLiveState`. WS handlers below write into those collections
 * on state / gateway-event delivery. Only `events` (debug log) and
 * `branchInfo` remain as local React state.
 */

import { createTransaction } from '@tanstack/db'
import { useAgent } from 'agents/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { agentSessionsCollection as sessionsCollection } from '~/db/agent-sessions-collection'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'
import { upsertSessionLiveState } from '~/db/session-live-state-collection'
import { useMessagesCollection } from '~/hooks/use-messages-collection'
import { useSessionLiveState } from '~/hooks/use-session-live-state'
import { contentToParts } from '~/lib/message-parts'
import type {
  ContentBlock,
  GateResponse,
  KataSessionState,
  SessionMessage,
  SessionState,
  SpawnConfig,
} from '~/lib/types'

export type { ContentBlock, GateResponse, SessionState as CodingAgentState, SpawnConfig }

export interface GatewayEvent {
  type: string
  [key: string]: unknown
}

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  model?: string
  isAutoCompactEnabled?: boolean
  autoCompactThreshold?: number
}

export interface UseCodingAgentResult {
  state: SessionState | null
  events: Array<{ ts: string; type: string; data?: unknown }>
  messages: SessionMessage[]
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
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
  branchInfo: Map<string, { current: number; total: number; siblings: string[] }>
  getBranches: (messageId: string) => Promise<SessionMessage[]>
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

/** Stamp a SessionMessage with its sessionId for the collection row. */
function toRow(msg: SessionMessage, sessionId: string): CachedMessage & Record<string, unknown> {
  return {
    id: msg.id,
    sessionId,
    role: msg.role,
    parts: msg.parts,
    createdAt: msg.createdAt,
  } as CachedMessage & Record<string, unknown>
}

/** Connect to a SessionDO instance by name; returns live state, messages, and RPC helpers. */
export function useCodingAgent(agentName: string): UseCodingAgentResult {
  const [events, setEvents] = useState<Array<{ ts: string; type: string; data?: unknown }>>([])
  const [branchInfo, setBranchInfo] = useState<
    Map<string, { current: number; total: number; siblings: string[] }>
  >(new Map())
  const prevAgentNameRef = useRef(agentName)
  // Per-session watermark for MessagesFrame `seq` (B1/B3). Keyed by agentName
  // so concurrent session tabs each keep their own highest-applied seq.
  const lastSeqRef = useRef<Map<string, number>>(new Map())

  // Per-agentName collection (memoised inside createMessagesCollection, so the
  // same factory call returns the same instance on re-render).
  const messagesCollection = useMemo(() => createMessagesCollection(agentName), [agentName])

  // Server-authoritative live state from the TanStack DB collection.
  const { state, contextUsage, kataState, sessionResult } = useSessionLiveState(agentName)

  // Reset per-session transient state on agentName change (tab switch without
  // remount). Collection rows for other sessions are untouched.
  if (prevAgentNameRef.current !== agentName) {
    lastSeqRef.current.delete(prevAgentNameRef.current)
    prevAgentNameRef.current = agentName
    setEvents([])
    setBranchInfo(new Map())
  }

  // Render source for messages: reactive live query on the persisted collection.
  // `isFetching` proxies the query-collection fetch state and feeds the
  // `isConnecting` derivation below, retiring the old `hydratedRef` gate.
  const { messages: cachedMessages, isFetching } = useMessagesCollection(agentName)
  const messages: SessionMessage[] = cachedMessages.map(toSessionMessage)

  /** Upsert a SessionMessage into the collection (dedup via .has()). */
  const upsert = useCallback(
    (msg: SessionMessage) => {
      const row = toRow(msg, agentName)
      try {
        if (messagesCollection.has(msg.id)) {
          messagesCollection.update(msg.id, (draft: CachedMessage) => {
            Object.assign(draft, row)
          })
        } else {
          messagesCollection.insert(row)
        }
      } catch {
        // Rare mutation-API contention; next event will retry.
      }
    },
    [agentName, messagesCollection],
  )

  const bulkUpsert = useCallback((msgs: SessionMessage[]) => msgs.forEach(upsert), [upsert])

  /** Replace this session's message set; deletes rows not in `newMsgs`, then upserts them. */
  const replaceAllMessages = useCallback(
    (newMsgs: SessionMessage[]) => {
      const newIds = new Set(newMsgs.map((m) => m.id))
      const staleIds: string[] = []
      try {
        for (const [id, row] of messagesCollection as Iterable<[string, CachedMessage]>) {
          if (row.sessionId === agentName && !newIds.has(id)) staleIds.push(id)
        }
      } catch {
        // Iteration rarely throws; skip stale cleanup.
      }
      if (staleIds.length > 0) {
        try {
          messagesCollection.delete(staleIds)
        } catch {
          // swallow
        }
      }
      bulkUpsert(newMsgs)
    },
    [agentName, bulkUpsert, messagesCollection],
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
          | { kind: 'delta'; upsert?: SessionMessage[]; remove?: string[] }
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
        replaceAllMessages(frame.payload.messages)
        map.set(agentName, Math.max(lastSeq, frame.payload.version))
        return
      }

      // kind === 'delta'
      if (frame.seq === lastSeq + 1) {
        const upsertList = frame.payload.upsert ?? []
        // GH#14 P3: user echoes reconcile via id match alone. The DO accepts
        // the client-proposed `client_message_id` as the primary id, so
        // TanStack DB deep-equality retires the optimistic row silently.
        for (const m of upsertList) upsert(m)
        const removeList = frame.payload.remove ?? []
        if (removeList.length > 0) {
          try {
            messagesCollection.delete(removeList)
          } catch {
            // swallow
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
    [agentName, upsert, replaceAllMessages, messagesCollection],
  )

  const connection = useAgent<SessionState>({
    agent: 'session-agent',
    name: agentName,
    onStateUpdate: (newState) => {
      upsertSessionLiveState(agentName, { state: newState, wsReadyState: 1 })
      // Mirror WS state into the sessions query collection (local-only, no
      // round-trip). `utils.writeUpdate` because `.update()` needs an onUpdate
      // handler that queryCollectionOptions doesn't configure.
      if (sessionsCollection.has(agentName)) {
        const patch: Partial<import('~/db/agent-sessions-collection').SessionRecord> = {
          id: agentName,
          status: newState.status,
          updatedAt: new Date().toISOString(),
        }
        if (newState.num_turns != null) patch.numTurns = newState.num_turns
        if (newState.total_cost_usd != null) patch.totalCostUsd = newState.total_cost_usd
        if (newState.duration_ms != null) patch.durationMs = newState.duration_ms
        sessionsCollection.utils.writeUpdate(patch)
      }
      // Hydration is owned by the queryCollection (`messagesCollection` factory
      // + `useMessagesCollection`). The WS snapshot still writes directly to
      // the collection as a latency optimisation; the queryFn is the
      // cold-start / stale-cache fallback with retry: 1, retryDelay: 500.
    },
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
                | { kind: 'delta'; upsert?: SessionMessage[]; remove?: string[] }
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
            replaceAllMessages((parsed as { messages: SessionMessage[] }).messages)
            return
          }
          return
        }

        // Legacy gateway_event format (non-message events only)
        if (parsed.type === 'gateway_event' && parsed.event) {
          const event = parsed.event as GatewayEvent & { uuid?: string; content?: unknown[] }
          setEvents((prev) => [
            ...prev,
            { ts: new Date().toISOString(), type: event.type, data: event },
          ])

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

          // Capture cost/duration from result event
          if (event.type === 'result') {
            const resultEvent = event as { total_cost_usd?: number; duration_ms?: number }
            if (resultEvent.total_cost_usd != null || resultEvent.duration_ms != null) {
              const sessionResult = {
                total_cost_usd: resultEvent.total_cost_usd ?? 0,
                duration_ms: resultEvent.duration_ms ?? 0,
              }
              upsertSessionLiveState(agentName, { sessionResult })
            }
          }
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

  const wsReadyState = state ? 1 : 0
  const isConnecting = isFetching || wsReadyState !== 1

  const rewind = useCallback(
    async (turnIndex: number) => {
      const result = (await connection.call('rewind', [turnIndex])) as {
        ok: boolean
        error?: string
      }
      if (result.ok) {
        // Trim displayed thread; deleted rows propagate via the live query.
        const kept = cachedMessages.slice(0, turnIndex + 1).map(toSessionMessage)
        replaceAllMessages(kept)
      }
      return result
    },
    [connection, cachedMessages, replaceAllMessages],
  )

  const refreshBranchInfo = useCallback(
    async (msgs: SessionMessage[]) => {
      const newBranchInfo = new Map<
        string,
        { current: number; total: number; siblings: string[] }
      >()

      for (const msg of msgs) {
        if (msg.role === 'user') {
          try {
            const msgIdx = msgs.findIndex((m) => m.id === msg.id)
            const parentId = msgIdx > 0 ? msgs[msgIdx - 1].id : null

            if (parentId) {
              const siblings = (await connection.call('getBranches', [
                parentId,
              ])) as SessionMessage[]
              const userSiblings = siblings.filter((s) => s.role === 'user')
              if (userSiblings.length > 1) {
                const currentIdx = userSiblings.findIndex((s) => s.id === msg.id)
                newBranchInfo.set(msg.id, {
                  current: currentIdx + 1,
                  total: userSiblings.length,
                  siblings: userSiblings.map((s) => s.id),
                })
              }
            }
          } catch {
            // Skip — non-critical
          }
        }
      }

      setBranchInfo(newBranchInfo)
    },
    [connection],
  )

  const getBranches = useCallback(
    async (messageId: string) => {
      return connection.call('getBranches', [messageId]) as Promise<SessionMessage[]>
    },
    [connection],
  )

  const resubmitMessage = useCallback(
    async (messageId: string, content: string) => {
      const result = (await connection.call('resubmitMessage', [messageId, content])) as {
        ok: boolean
        leafId?: string
        error?: string
      }
      if (result.ok && result.leafId) {
        const newMessages = (await connection.call('getMessages', [
          { session_hint: agentName, leafId: result.leafId },
        ])) as SessionMessage[]
        if (newMessages.length > 0) {
          replaceAllMessages(newMessages)
          await refreshBranchInfo(newMessages)
        }
      }
      return result
    },
    [connection, agentName, refreshBranchInfo, replaceAllMessages],
  )

  const navigateBranch = useCallback(
    async (messageId: string, direction: 'prev' | 'next') => {
      const info = branchInfo.get(messageId)
      if (!info) return

      const currentIdx = info.current - 1
      const targetIdx = direction === 'prev' ? currentIdx - 1 : currentIdx + 1
      if (targetIdx < 0 || targetIdx >= info.siblings.length) return

      const targetSiblingId = info.siblings[targetIdx]

      const branchMessages = (await connection.call('getMessages', [
        { session_hint: agentName, leafId: targetSiblingId },
      ])) as SessionMessage[]

      if (branchMessages.length > 0) {
        replaceAllMessages(branchMessages)
        await refreshBranchInfo(branchMessages)
      }
    },
    [connection, agentName, branchInfo, refreshBranchInfo, replaceAllMessages],
  )

  /**
   * GH#14 P3: optimistic user-row inserts use `createTransaction` with
   * server-accepts-client-ID reconciliation. The DO accepts the
   * `client_message_id` as the primary id, so echoes reconcile via
   * TanStack DB deep-equality — no manual delete+insert churn, no
   * turnHint sort hints, no maxServerTurn bookkeeping.
   */
  const sendMessage = useCallback(
    async (content: string | ContentBlock[], opts?: { submitId?: string }) => {
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
          const result = (await connection.call('sendMessage', [
            content,
            { ...opts, client_message_id: clientMessageId },
          ])) as { ok: boolean; error?: string; recoverable?: string }
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
        return { ok: true }
      } catch (err) {
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
          // but the snapshot emitted by forkWithHistory + replaceAllMessages
          // still converges the collection. Documented as a deviation in
          // GH#14 P3.
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
    state,
    events,
    messages,
    sessionResult,
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
    branchInfo,
    getBranches,
    resubmitMessage,
    navigateBranch,
  }
}
