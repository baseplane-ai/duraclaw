/**
 * Hook for connecting to a SessionDO via the agents/react useAgent hook.
 *
 * Connects over WebSocket to the SessionDO Durable Object.
 * The agents SDK auto-syncs state on connection and broadcasts state updates.
 *
 * Ported from baseplane agent-orch, adapted for duraclaw's SessionDO.
 */

import { useAgent } from 'agents/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type CachedMessage, messagesCollection } from '~/db/messages-collection'
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
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [sessionResult, setSessionResult] = useState<{
    total_cost_usd: number
    duration_ms: number
  } | null>(null)
  const [kataState, setKataState] = useState<KataSessionState | null>(null)
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const hydratedRef = useRef(false)
  const cacheSeededRef = useRef(false)
  const knownEventUuidsRef = useRef<Set<string>>(new Set())
  const optimisticIdsRef = useRef<Set<string>>(new Set())
  const prevStatusRef = useRef<string | null>(null)
  const prevAgentNameRef = useRef(agentName)

  // Reset all state when agentName changes (e.g. tab switch without remount)
  if (prevAgentNameRef.current !== agentName) {
    prevAgentNameRef.current = agentName
    hydratedRef.current = false
    cacheSeededRef.current = false
    knownEventUuidsRef.current = new Set()
    optimisticIdsRef.current = new Set()
    prevStatusRef.current = null
    setState(null)
    setEvents([])
    setMessages([])
    setSessionResult(null)
    setKataState(null)
    setContextUsage(null)
  }

  /** Write a message to the local cache collection (cache-behind). */
  const cacheMessage = useCallback(
    (msg: Omit<CachedMessage, 'sessionId'>) => {
      try {
        messagesCollection.insert({
          ...msg,
          sessionId: agentName,
        } as CachedMessage & Record<string, unknown>)
      } catch {
        // Ignore duplicate inserts
      }
    },
    [agentName],
  )

  // Cache-first: use reactive query to load cached messages from OPFS immediately.
  // This fires as soon as the persisted collection hydrates, before WS connects.
  const { messages: cachedMessages } = useMessagesCollection(agentName)

  useEffect(() => {
    // Seed messages state from cache once, before WS hydration arrives
    if (cachedMessages.length > 0 && !cacheSeededRef.current && !hydratedRef.current) {
      cacheSeededRef.current = true
      for (const msg of cachedMessages) {
        knownEventUuidsRef.current.add(msg.id)
      }
      setMessages(
        cachedMessages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts,
          createdAt: m.createdAt ? new Date(m.createdAt as string) : undefined,
        })),
      )
    }
  }, [cachedMessages])

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

        // NEW: Handle SessionMessage wire format (single message upsert)
        if (parsed.type === 'message' && parsed.message) {
          const msg = parsed.message as SessionMessage
          setMessages((prev) => {
            // Check if this is a server echo of an optimistic user message
            if (msg.role === 'user') {
              const withoutOptimistic = prev.filter((m) => !optimisticIdsRef.current.has(m.id))
              const idx = withoutOptimistic.findIndex((m) => m.id === msg.id)
              if (idx !== -1) {
                const updated = [...withoutOptimistic]
                updated[idx] = msg
                return updated
              }
              return [...withoutOptimistic, msg]
            }
            // For non-user messages, upsert by id
            const idx = prev.findIndex((m) => m.id === msg.id)
            if (idx !== -1) {
              const updated = [...prev]
              updated[idx] = msg
              return updated
            }
            return [...prev, msg]
          })
          // Cache-behind write
          cacheMessage({
            id: msg.id,
            role: msg.role,
            parts: msg.parts,
            createdAt: msg.createdAt,
          })
          return
        }

        // NEW: Handle bulk message replay on connect
        if (parsed.type === 'messages' && Array.isArray(parsed.messages)) {
          const msgs = parsed.messages as SessionMessage[]
          setMessages(msgs)
          for (const msg of msgs) {
            knownEventUuidsRef.current.add(msg.id)
          }
          hydratedRef.current = true
          for (const msg of msgs) {
            cacheMessage({
              id: msg.id,
              role: msg.role,
              parts: msg.parts,
              createdAt: msg.createdAt,
            })
          }
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

  /** Fetch persisted messages, populate messages state and dedup set. */
  async function hydrateMessages(conn: typeof connection) {
    const hints = { session_hint: agentName }
    const serverMessages = (await conn.call('getMessages', [{ ...hints }])) as SessionMessage[]

    if (serverMessages.length > 0) {
      for (const msg of serverMessages) {
        knownEventUuidsRef.current.add(msg.id)
      }
      setMessages(serverMessages)
      // Write hydrated messages to local collection for future cache-first loads
      for (const msg of serverMessages) {
        cacheMessage({
          id: msg.id,
          role: msg.role,
          parts: msg.parts,
          createdAt: msg.createdAt,
        })
      }
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

  const injectQaPair = useCallback((question: string, answer: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `qa-${Date.now()}`,
        role: 'qa_pair',
        parts: [{ type: 'text', text: `Q: ${question}\nA: ${answer}` }],
      },
    ])
  }, [])

  const wsReadyState = state ? 1 : 0
  const isConnecting = !hydratedRef.current

  const rewind = useCallback(
    async (turnIndex: number) => {
      const result = (await connection.call('rewind', [turnIndex])) as {
        ok: boolean
        error?: string
      }
      if (result.ok) {
        setMessages((prev) => prev.slice(0, turnIndex + 1))
      }
      return result
    },
    [connection],
  )

  const sendMessage = useCallback(
    async (content: string | ContentBlock[]) => {
      const optimisticId = `usr-optimistic-${Date.now()}`
      const textContent = typeof content === 'string' ? content : JSON.stringify(content)
      optimisticIdsRef.current.add(optimisticId)
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          role: 'user',
          parts: [{ type: 'text', text: textContent }],
          createdAt: new Date(),
        },
      ])
      const result = (await connection.call('sendMessage', [content])) as {
        ok: boolean
        error?: string
      }
      if (!result.ok) {
        optimisticIdsRef.current.delete(optimisticId)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
      }
      return result
    },
    [connection],
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
  }
}
