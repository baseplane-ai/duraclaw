/**
 * Hook for connecting to a SessionDO via the agents/react useAgent hook.
 *
 * Connects over WebSocket to the SessionDO Durable Object.
 * The agents SDK auto-syncs state on connection and broadcasts state updates.
 *
 * Ported from baseplane agent-orch, adapted for duraclaw's SessionDO.
 */

import { useAgent } from 'agents/react'
import { useCallback, useRef, useState } from 'react'
import type {
  ContentBlock,
  GateResponse,
  KataSessionState,
  SessionState,
  SpawnConfig,
} from '~/lib/types'
import type { ChatMessage } from './ChatThread'

export type { ContentBlock, GateResponse, SessionState as CodingAgentState, SpawnConfig }

export interface GatewayEvent {
  type: string
  [key: string]: unknown
}

export interface UseCodingAgentResult {
  state: SessionState | null
  events: Array<{ ts: string; type: string; data?: unknown }>
  messages: ChatMessage[]
  streamingContent: string
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
  kataState: KataSessionState | null
  wsReadyState: number
  spawn: (config: SpawnConfig) => Promise<unknown>
  stop: (reason?: string) => Promise<unknown>
  abort: (reason?: string) => Promise<unknown>
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
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingContent, setStreamingContent] = useState('')
  const [sessionResult, setSessionResult] = useState<{
    total_cost_usd: number
    duration_ms: number
  } | null>(null)
  const [kataState, setKataState] = useState<KataSessionState | null>(null)
  const hydratedRef = useRef(false)
  const knownEventUuidsRef = useRef<Set<string>>(new Set())
  const optimisticIdsRef = useRef<Set<string>>(new Set())
  const prevStatusRef = useRef<string | null>(null)

  const connection = useAgent<SessionState>({
    agent: 'session-agent',
    name: agentName,
    onStateUpdate: (newState) => {
      const prevStatus = prevStatusRef.current
      prevStatusRef.current = newState.status
      setState(newState)
      // Hydrate messages on first state sync
      if (!hydratedRef.current) {
        hydratedRef.current = true
        hydrateMessages(connection).catch(() => {})
      }
      // Re-hydrate when a resumed session completes
      if (
        prevStatus === 'running' &&
        (newState.status === 'idle' || newState.status === 'completed')
      ) {
        hydrateMessages(connection).catch(() => {})
      }
    },
    onMessage: (message: MessageEvent) => {
      try {
        const parsed = JSON.parse(typeof message.data === 'string' ? message.data : '')
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

          // Accumulate streaming text from partial_assistant deltas
          if (event.type === 'partial_assistant' && Array.isArray(event.content)) {
            setStreamingContent((prev) => {
              let delta = ''
              for (const block of event.content as unknown[]) {
                const b = block as Record<string, unknown>
                if (typeof b.text === 'string') delta += b.text
                else if (typeof b.delta === 'string') delta += b.delta
                else if (b.delta && typeof (b.delta as Record<string, unknown>).text === 'string') {
                  delta += (b.delta as Record<string, unknown>).text
                }
              }
              return prev + delta
            })
          }

          // Render file_changed events as transient messages
          if (event.type === 'file_changed') {
            const fileEvent = event as { path?: string; tool?: string }
            setMessages((prev) => [
              ...prev,
              {
                id: `file-${Date.now()}-${Math.random()}`,
                role: 'tool' as const,
                type: 'file_changed',
                content: JSON.stringify({ path: fileEvent.path, tool: fileEvent.tool }),
              },
            ])
          }

          // Build messages from events — dedup against hydrated messages
          if (event.type === 'assistant' && event.uuid) {
            setStreamingContent('') // Clear streaming on final content
            if (knownEventUuidsRef.current.has(event.uuid)) return
            setMessages((prev) => {
              if (prev.some((m) => m.event_uuid === event.uuid)) return prev
              return [
                ...prev,
                {
                  id: event.uuid as string,
                  role: 'assistant',
                  type: 'text',
                  content: JSON.stringify(event.content),
                  event_uuid: event.uuid,
                },
              ]
            })
          } else if (event.type === 'tool_result' && event.uuid) {
            if (knownEventUuidsRef.current.has(event.uuid)) return
            setMessages((prev) => {
              if (prev.some((m) => m.event_uuid === event.uuid)) return prev
              return [
                ...prev,
                {
                  id: `tool-${event.uuid}`,
                  role: 'tool',
                  type: 'tool_result',
                  content: JSON.stringify(event.content),
                  event_uuid: event.uuid,
                },
              ]
            })
          }
        } else if (parsed.type === 'user_message') {
          // User message broadcast from DO — skip if we already added it optimistically
          const broadcastContent = JSON.stringify(parsed.content)
          setMessages((prev) => {
            const isDuplicate = prev.some(
              (m) =>
                m.role === 'user' &&
                optimisticIdsRef.current.has(String(m.id)) &&
                m.content === broadcastContent,
            )
            if (isDuplicate) return prev
            return [
              ...prev,
              {
                id: `user-${Date.now()}`,
                role: 'user',
                type: 'text',
                content: broadcastContent,
              },
            ]
          })
        }
      } catch {
        // Ignore non-JSON messages (state sync handled by onStateUpdate)
      }
    },
  })

  /** Fetch persisted messages with pagination, populate messages state and dedup set. */
  async function hydrateMessages(conn: typeof connection) {
    const PAGE_LIMIT = 200
    let allMessages: ChatMessage[] = []
    let offset = 0
    let batch: ChatMessage[]
    do {
      batch = (await conn.call('getMessages', [{ offset, limit: PAGE_LIMIT }])) as ChatMessage[]
      allMessages = [...allMessages, ...batch]
      offset += batch.length
    } while (batch.length >= PAGE_LIMIT)

    if (allMessages.length > 0) {
      for (const msg of allMessages) {
        if (msg.event_uuid) {
          knownEventUuidsRef.current.add(msg.event_uuid)
        }
      }
      setMessages((prev) => {
        if (prev.length === 0) return allMessages
        const hydratedIds = new Set(allMessages.map((m) => m.event_uuid).filter(Boolean))
        const hydratedUserContent = new Set(
          allMessages.filter((m) => m.role === 'user').map((m) => m.content),
        )
        const newRealtime = prev.filter((m) => {
          if (m.event_uuid) return !hydratedIds.has(m.event_uuid)
          if (m.role === 'user') return !hydratedUserContent.has(m.content)
          return true
        })
        return [...allMessages, ...newRealtime]
      })
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
        role: 'qa_pair' as const,
        type: 'qa_pair',
        content: JSON.stringify({ question, answer }),
      },
    ])
  }, [])

  const wsReadyState = state ? 1 : 0

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
      const optimisticId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      optimisticIdsRef.current.add(optimisticId)
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          role: 'user',
          type: 'text',
          content: JSON.stringify(content),
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
    streamingContent,
    sessionResult,
    kataState,
    wsReadyState,
    spawn,
    stop,
    abort,
    resolveGate,
    sendMessage,
    rewind,
    injectQaPair,
  }
}
