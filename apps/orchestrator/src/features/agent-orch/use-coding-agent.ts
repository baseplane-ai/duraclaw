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

import { useAgent } from 'agents/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { agentSessionsCollection as sessionsCollection } from '~/db/agent-sessions-collection'
import { type CachedMessage, messagesCollection } from '~/db/messages-collection'
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

const TURN_ID_RE = /^(?:usr|msg|err)-(\d+)$/

/** Compute the highest server-assigned turn number from the current message set. */
function maxServerTurn(messages: CachedMessage[]): number {
  let max = 0
  for (const m of messages) {
    const match = TURN_ID_RE.exec(m.id)
    if (match) {
      const n = Number.parseInt(match[1], 10)
      if (n > max) max = n
    }
  }
  return max
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
  const hydratedRef = useRef(false)
  const prevStatusRef = useRef<string | null>(null)
  const prevAgentNameRef = useRef(agentName)

  // Server-authoritative live state from the TanStack DB collection.
  const { state, contextUsage, kataState, sessionResult } = useSessionLiveState(agentName)

  // Reset per-session transient state on agentName change (tab switch without
  // remount). Collection rows for other sessions are untouched.
  if (prevAgentNameRef.current !== agentName) {
    prevAgentNameRef.current = agentName
    hydratedRef.current = false
    prevStatusRef.current = null
    setEvents([])
    setBranchInfo(new Map())
  }

  // Render source for messages: reactive live query on the persisted collection.
  const { messages: cachedMessages } = useMessagesCollection(agentName)
  const messages: SessionMessage[] = cachedMessages.map(toSessionMessage)

  /** Upsert a SessionMessage into the collection (dedup via .has()). */
  const upsert = useCallback(
    (msg: SessionMessage) => {
      const row = toRow(msg, agentName)
      try {
        if (messagesCollection.has(msg.id)) {
          messagesCollection.update(msg.id, (draft) => {
            Object.assign(draft, row)
          })
        } else {
          messagesCollection.insert(row)
        }
      } catch {
        // Rare mutation-API contention; next event will retry.
      }
    },
    [agentName],
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
    [agentName, bulkUpsert],
  )

  /** Drop the oldest `usr-optimistic-*` row for this session (FIFO; one echo → one clear). */
  const clearOldestOptimisticRow = useCallback(() => {
    let oldestId: string | null = null
    let oldestTs = Number.POSITIVE_INFINITY
    try {
      for (const [id, row] of messagesCollection as Iterable<[string, CachedMessage]>) {
        if (row.sessionId !== agentName) continue
        const match = /^usr-optimistic-(\d+)$/.exec(id)
        if (!match) continue
        const ts = Number.parseInt(match[1], 10)
        if (ts < oldestTs) {
          oldestTs = ts
          oldestId = id
        }
      }
    } catch {
      return
    }
    if (oldestId) {
      try {
        messagesCollection.delete(oldestId)
      } catch {
        // Already gone (raced with another echo or rollback).
      }
    }
  }, [agentName])

  const connection = useAgent<SessionState>({
    agent: 'session-agent',
    name: agentName,
    onStateUpdate: (newState) => {
      const prevStatus = prevStatusRef.current
      prevStatusRef.current = newState.status
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
      // Hydrate messages on first state sync. Only flip the ref on non-empty
      // so a transient empty doesn't permanently gate future attempts.
      if (!hydratedRef.current) {
        hydrateMessages(connection)
          .then((msgCount) => {
            if (msgCount > 0) hydratedRef.current = true
            else if (newState.sdk_session_id) {
              // History expected but gateway may not be hydrated yet; retry once.
              setTimeout(() => {
                hydrateMessages(connection)
                  .then((n) => {
                    if (n > 0) hydratedRef.current = true
                  })
                  .catch(() => {})
              }, 500)
            } else {
              hydratedRef.current = true
            }
          })
          .catch(() => {})
      }
      // Re-hydrate when a resumed session completes.
      if (prevStatus === 'running' && newState.status === 'idle') {
        hydrateMessages(connection).catch(() => {})
      }
    },
    onMessage: (message: MessageEvent) => {
      try {
        const parsed = JSON.parse(typeof message.data === 'string' ? message.data : '')

        // Single SessionMessage upsert. Echoes of canonical user turns retire
        // exactly one pending optimistic row (FIFO; one echo → one clear).
        if (parsed.type === 'message' && parsed.message) {
          const msg = parsed.message as SessionMessage
          if (msg.role === 'user' && !msg.id.startsWith('usr-optimistic-')) {
            clearOldestOptimisticRow()
          }
          upsert(msg)
          return
        }

        // Bulk message replay on connect.
        if (parsed.type === 'messages' && Array.isArray(parsed.messages)) {
          replaceAllMessages(parsed.messages as SessionMessage[])
          hydratedRef.current = true
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

  /** Fetch persisted messages and write them into the collection. */
  async function hydrateMessages(conn: typeof connection): Promise<number> {
    const hints = { session_hint: agentName }
    const serverMessages = (await conn.call('getMessages', [{ ...hints }])) as SessionMessage[]

    if (serverMessages.length > 0) {
      bulkUpsert(serverMessages)
      // Refresh branch info after hydration
      refreshBranchInfo(serverMessages).catch(() => {})
    }
    return serverMessages.length
  }

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
    [agentName],
  )

  const wsReadyState = state ? 1 : 0
  const isConnecting = !hydratedRef.current

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

  /** Insert an optimistic user row; returns its id so callers can roll it back. */
  const insertOptimistic = useCallback(
    (content: string | ContentBlock[]): string => {
      const optimisticId = `usr-optimistic-${Date.now()}`
      const turnHint = maxServerTurn(cachedMessages) + 1
      try {
        messagesCollection.insert({
          id: optimisticId,
          sessionId: agentName,
          role: 'user',
          parts: contentToParts(content),
          createdAt: new Date(),
          turnHint,
        } as CachedMessage & Record<string, unknown>)
      } catch {
        // Duplicate id (extremely unlikely) — swallow.
      }
      return optimisticId
    },
    [agentName, cachedMessages],
  )

  const deleteOptimistic = useCallback((id: string) => {
    try {
      messagesCollection.delete(id)
    } catch {
      // Already gone.
    }
  }, [])

  const sendMessage = useCallback(
    async (content: string | ContentBlock[], opts?: { submitId?: string }) => {
      const optimisticId = insertOptimistic(content)
      const result = (await connection.call('sendMessage', [content, opts])) as {
        ok: boolean
        error?: string
      }
      if (!result.ok) deleteOptimistic(optimisticId)
      return result
    },
    [connection, insertOptimistic, deleteOptimistic],
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

      const optimisticId = insertOptimistic(text)
      try {
        const result = (await connection.call('sendMessage', [text, { submitId }])) as {
          ok: boolean
          error?: string
        }
        if (!result.ok) {
          deleteOptimistic(optimisticId)
          runRestore()
          return { ok: false, sent: false, error: result.error }
        }
        return { ok: true, sent: true }
      } catch (err) {
        deleteOptimistic(optimisticId)
        runRestore()
        return {
          ok: false,
          sent: false,
          error: err instanceof Error ? err.message : 'send failed',
        }
      }
    },
    [connection, insertOptimistic, deleteOptimistic],
  )

  const forkWithHistory = useCallback(
    async (content: string | ContentBlock[]) => {
      const optimisticId = insertOptimistic(content)
      const result = (await connection.call('forkWithHistory', [content])) as {
        ok: boolean
        error?: string
      }
      if (!result.ok) deleteOptimistic(optimisticId)
      return result
    },
    [connection, insertOptimistic, deleteOptimistic],
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
