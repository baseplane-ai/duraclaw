/**
 * Hook for connecting to a SessionDO via the agents/react useAgent hook.
 *
 * Connects over WebSocket to the SessionDO Durable Object.
 * The agents SDK auto-syncs state on connection and broadcasts state updates.
 *
 * Messages flow through `messagesCollection` as the single source of truth:
 *   WS events → collection writes (optimistic, sync) → useLiveQuery → React render
 *   OPFS persistence happens async in the background.
 */

import { useAgent } from 'agents/react'
import { useCallback, useRef, useState } from 'react'
import { pruneStaleMessages, upsertMessage } from '~/db/messages-collection'
import { sessionsCollection } from '~/db/sessions-collection'
import { useMessagesCollection } from '~/hooks/use-messages-collection'
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

/**
 * Connect to a SessionDO instance by name.
 *
 * Returns live state (synced via WebSocket), accumulated events and messages,
 * and RPC call helpers for spawn/abort/resolveGate/sendMessage.
 */
export function useCodingAgent(agentName: string): UseCodingAgentResult {
  const [state, setState] = useState<SessionState | null>(null)
  const [events, setEvents] = useState<Array<{ ts: string; type: string; data?: unknown }>>([])
  const [sessionResult, setSessionResult] = useState<{
    total_cost_usd: number
    duration_ms: number
  } | null>(null)
  const [kataState, setKataState] = useState<KataSessionState | null>(null)
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const [branchInfo, setBranchInfo] = useState<
    Map<string, { current: number; total: number; siblings: string[] }>
  >(new Map())
  const hydratedRef = useRef(false)
  const optimisticIdsRef = useRef<Set<string>>(new Set())
  const prevStatusRef = useRef<string | null>(null)
  const prevAgentNameRef = useRef(agentName)

  // Reset non-message state when agentName changes (e.g. tab switch without remount).
  // Messages don't need resetting — useMessagesCollection filters by agentName reactively.
  if (prevAgentNameRef.current !== agentName) {
    prevAgentNameRef.current = agentName
    hydratedRef.current = false
    optimisticIdsRef.current = new Set()
    prevStatusRef.current = null
    setState(null)
    setEvents([])
    setSessionResult(null)
    setKataState(null)
    setContextUsage(null)
  }

  // Single source of truth: reactive query over the collection, filtered by sessionId.
  // Returns cached messages immediately on mount (from OPFS), then reacts to writes.
  const { messages: collectionMessages } = useMessagesCollection(agentName)

  // Map CachedMessage[] → SessionMessage[] for consumers.
  // Filter out optimistic IDs that have been superseded by server echoes.
  const messages: SessionMessage[] = collectionMessages
    .filter((m) => !optimisticIdsRef.current.has(m.id) || m.sessionId === agentName)
    .map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      createdAt: m.createdAt ? new Date(m.createdAt as string) : undefined,
    }))

  /** Write a batch of messages to the collection and prune stale entries. */
  const syncMessagesToCollection = useCallback(
    (msgs: SessionMessage[]) => {
      const keepIds = new Set<string>()
      for (const msg of msgs) {
        keepIds.add(msg.id)
        upsertMessage(agentName, {
          id: msg.id,
          role: msg.role,
          parts: msg.parts,
          createdAt: msg.createdAt,
        })
      }
      // Remove messages for this session that aren't in the new set
      pruneStaleMessages(agentName, keepIds)
    },
    [agentName],
  )

  const connection = useAgent<SessionState>({
    agent: 'session-agent',
    name: agentName,
    onStateUpdate: (newState) => {
      const prevStatus = prevStatusRef.current
      prevStatusRef.current = newState.status
      setState(newState)
      // WS bridge: update sessions collection with fresh status
      try {
        sessionsCollection.update(agentName, (draft) => {
          draft.status = newState.status
          draft.updated_at = new Date().toISOString()
          if (newState.num_turns != null) draft.num_turns = newState.num_turns
          if (newState.total_cost_usd != null) draft.total_cost_usd = newState.total_cost_usd
          if (newState.duration_ms != null) draft.duration_ms = newState.duration_ms
        })
      } catch {
        // Collection item may not exist yet — ignore
      }
      // Hydrate messages on first state sync
      if (!hydratedRef.current) {
        hydratedRef.current = true
        hydrateMessages(connection).catch(() => {})
      }
      // Re-hydrate when a resumed session completes
      if (prevStatus === 'running' && newState.status === 'idle') {
        hydrateMessages(connection).catch(() => {})
      }
    },
    onMessage: (message: MessageEvent) => {
      try {
        const parsed = JSON.parse(typeof message.data === 'string' ? message.data : '')

        // Handle SessionMessage wire format (single message upsert)
        if (parsed.type === 'message' && parsed.message) {
          const msg = parsed.message as SessionMessage

          // If this is a server echo of an optimistic user message, clean up optimistic IDs
          if (msg.role === 'user') {
            // Remove all optimistic IDs — server echo means they've been accepted
            optimisticIdsRef.current.clear()
          }

          upsertMessage(agentName, {
            id: msg.id,
            role: msg.role,
            parts: msg.parts,
            createdAt: msg.createdAt,
          })
          return
        }

        // Handle bulk message replay on connect
        if (parsed.type === 'messages' && Array.isArray(parsed.messages)) {
          const msgs = parsed.messages as SessionMessage[]
          hydratedRef.current = true
          syncMessagesToCollection(msgs)
          // Refresh branch info after bulk replay
          refreshBranchInfo(msgs).catch(() => {})
          return
        }

        // Handle legacy gateway_event format (non-message events only)
        if (parsed.type === 'gateway_event' && parsed.event) {
          const event = parsed.event as GatewayEvent & { uuid?: string; content?: unknown[] }
          setEvents((prev) => [
            ...prev,
            { ts: new Date().toISOString(), type: event.type, data: event },
          ])

          // Capture kata session state
          if (event.type === 'kata_state') {
            setKataState((event as unknown as { kata_state: KataSessionState }).kata_state)
          }

          // Capture context usage from get-context-usage response
          if (event.type === 'context_usage') {
            const usage = (event as unknown as { usage: Record<string, unknown> }).usage
            setContextUsage({
              totalTokens: (usage.totalTokens as number) ?? 0,
              maxTokens: (usage.maxTokens as number) ?? 0,
              percentage: (usage.percentage as number) ?? 0,
              model: usage.model as string | undefined,
              isAutoCompactEnabled: usage.isAutoCompactEnabled as boolean | undefined,
              autoCompactThreshold: usage.autoCompactThreshold as number | undefined,
            })
          }

          // Capture cost/duration from result event
          if (event.type === 'result') {
            const resultEvent = event as { total_cost_usd?: number; duration_ms?: number }
            if (resultEvent.total_cost_usd != null || resultEvent.duration_ms != null) {
              setSessionResult({
                total_cost_usd: resultEvent.total_cost_usd ?? 0,
                duration_ms: resultEvent.duration_ms ?? 0,
              })
            }
          }
        }
      } catch {
        // Ignore non-JSON messages (state sync handled by onStateUpdate)
      }
    },
  })

  /** Fetch persisted messages from the DO, write to collection. */
  async function hydrateMessages(conn: typeof connection) {
    const hints = { session_hint: agentName }
    const serverMessages = (await conn.call('getMessages', [{ ...hints }])) as SessionMessage[]

    if (serverMessages.length > 0) {
      syncMessagesToCollection(serverMessages)
      // Refresh branch info after hydration
      refreshBranchInfo(serverMessages).catch(() => {})
    }
  }

  const spawn = useCallback(
    async (config: SpawnConfig) => {
      return connection.call('spawn', [config])
    },
    [connection],
  )

  const stop = useCallback(
    async (reason?: string) => {
      return connection.call('stop', [reason])
    },
    [connection],
  )

  const abort = useCallback(
    async (reason?: string) => {
      return connection.call('abort', [reason])
    },
    [connection],
  )

  const interrupt = useCallback(async () => {
    return connection.call('interrupt', [])
  }, [connection])

  const getContextUsage = useCallback(async () => {
    return connection.call('getContextUsage', [])
  }, [connection])

  const resolveGate = useCallback(
    async (gateId: string, response: GateResponse) => {
      return connection.call('resolveGate', [gateId, response])
    },
    [connection],
  )

  const injectQaPair = useCallback(
    (question: string, answer: string) => {
      upsertMessage(agentName, {
        id: `qa-${Date.now()}`,
        role: 'qa_pair',
        parts: [{ type: 'text', text: `Q: ${question}\nA: ${answer}` }],
      })
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
        // Re-hydrate to get the correct message set after rewind
        const hints = { session_hint: agentName }
        const msgs = (await connection.call('getMessages', [{ ...hints }])) as SessionMessage[]
        if (msgs.length > 0) {
          syncMessagesToCollection(msgs)
        }
      }
      return result
    },
    [connection, agentName, syncMessagesToCollection],
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
          syncMessagesToCollection(newMessages)
          await refreshBranchInfo(newMessages)
        }
      }
      return result
    },
    [connection, agentName, refreshBranchInfo, syncMessagesToCollection],
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
        syncMessagesToCollection(branchMessages)
        await refreshBranchInfo(branchMessages)
      }
    },
    [connection, agentName, branchInfo, refreshBranchInfo, syncMessagesToCollection],
  )

  const sendMessage = useCallback(
    async (content: string | ContentBlock[]) => {
      const optimisticId = `usr-optimistic-${Date.now()}`
      const textContent = typeof content === 'string' ? content : JSON.stringify(content)
      optimisticIdsRef.current.add(optimisticId)

      // Optimistic insert into collection — renders immediately via useLiveQuery
      upsertMessage(agentName, {
        id: optimisticId,
        role: 'user',
        parts: [{ type: 'text', text: textContent }],
        createdAt: new Date(),
      })

      const result = (await connection.call('sendMessage', [content])) as {
        ok: boolean
        error?: string
      }
      if (!result.ok) {
        // Rollback: remove optimistic message from collection
        optimisticIdsRef.current.delete(optimisticId)
        try {
          pruneStaleMessages(
            agentName,
            new Set(collectionMessages.filter((m) => m.id !== optimisticId).map((m) => m.id)),
          )
        } catch {
          // Collection may not have the message
        }
      }
      return result
    },
    [connection, agentName, collectionMessages],
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
    rewind,
    injectQaPair,
    branchInfo,
    getBranches,
    resubmitMessage,
    navigateBranch,
  }
}
