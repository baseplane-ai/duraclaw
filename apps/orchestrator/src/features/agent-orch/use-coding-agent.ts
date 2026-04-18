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
import type * as Y from 'yjs'
import { type CachedMessage, messagesCollection } from '~/db/messages-collection'
import { sessionsCollection } from '~/db/sessions-collection'
import { useMessagesCollection } from '~/hooks/use-messages-collection'
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
  /**
   * Submit a collaborative draft held in a shared Y.Text.
   *
   * Snapshots the text, optimistically clears it in a Y.Doc transaction so
   * every connected peer sees the textarea empty immediately, then calls
   * `sendMessage` with a fresh submitId for server-side idempotency. If the
   * RPC fails, the original text is re-inserted in another transaction so
   * the draft reappears for all peers.
   */
  submitDraft: (yText: Y.Text) => Promise<{ ok: boolean; error?: string; sent?: boolean }>
  /**
   * Spawn a fresh SDK session with the current conversation transcript
   * prepended as context. Use to recover from an orphaned sdk_session_id
   * (sendMessage surfaces `{recoverable: 'forkWithHistory'}` in that case)
   * or whenever the user wants a clean context window without losing thread.
   */
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
  const [branchInfo, setBranchInfo] = useState<
    Map<string, { current: number; total: number; siblings: string[] }>
  >(new Map())
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
      // WS bridge: update sessions collection with fresh status. This is a
      // local-only mirror of the WS state (no server round-trip), so we use
      // utils.writeUpdate — the direct .update() API requires an onUpdate
      // mutation handler and queryCollectionOptions doesn't configure one
      // (it's a read-only query collection; writes go straight to synced
      // state). Skip if record not yet synced — next refetch will pick up
      // the new state naturally.
      if (sessionsCollection.has(agentName)) {
        const patch: Partial<import('~/db/sessions-collection').SessionRecord> = {
          id: agentName,
          status: newState.status,
          updatedAt: new Date().toISOString(),
        }
        if (newState.num_turns != null) patch.numTurns = newState.num_turns
        if (newState.total_cost_usd != null) patch.totalCostUsd = newState.total_cost_usd
        if (newState.duration_ms != null) patch.durationMs = newState.duration_ms
        sessionsCollection.utils.writeUpdate(patch)
      }
      // Hydrate messages on first state sync. Only flip the ref on success so
      // that a transient empty/failed RPC doesn't permanently gate further
      // attempts — URL-direct loads often race with DO cold-start, and the
      // first getMessages call can return empty before gateway hydration
      // completes on the DO side.
      if (!hydratedRef.current) {
        hydrateMessages(connection)
          .then((msgCount) => {
            if (msgCount > 0) {
              hydratedRef.current = true
            } else {
              // Session exists and should have history (sdk_session_id set) but
              // returned empty — retry once after the DO has had a chance to
              // populate via hydrateFromGateway.
              const hasExistingSession = Boolean(newState.sdk_session_id)
              if (hasExistingSession) {
                setTimeout(() => {
                  hydrateMessages(connection)
                    .then((n) => {
                      if (n > 0) hydratedRef.current = true
                    })
                    .catch(() => {})
                }, 500)
              } else {
                // Fresh session with no prior history — gate off, nothing to retry.
                hydratedRef.current = true
              }
            }
          })
          .catch(() => {})
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
  async function hydrateMessages(conn: typeof connection): Promise<number> {
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
      // Refresh branch info after hydration
      refreshBranchInfo(serverMessages).catch(() => {})
    }
    return serverMessages.length
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
          setMessages(newMessages)
          await refreshBranchInfo(newMessages)
        }
      }
      return result
    },
    [connection, agentName, refreshBranchInfo],
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
        setMessages(branchMessages)
        await refreshBranchInfo(branchMessages)
      }
    },
    [connection, agentName, branchInfo, refreshBranchInfo],
  )

  const sendMessage = useCallback(
    async (content: string | ContentBlock[], opts?: { submitId?: string }) => {
      const optimisticId = `usr-optimistic-${Date.now()}`
      optimisticIdsRef.current.add(optimisticId)
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          role: 'user',
          parts: contentToParts(content),
          createdAt: new Date(),
        },
      ])
      const result = (await connection.call('sendMessage', [content, opts])) as {
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

  /**
   * Draft submit wrapper that clears a shared Y.Text optimistically and
   * restores it on RPC failure. Honors `window.__mockSendFailure` in dev
   * mode so VP2's failure-rollback test can be exercised without mocking
   * the WebSocket layer.
   *
   * Callers typically obtain `yText` from `useSessionCollab`'s returned doc
   * via `yDoc.getText("draft")` — the conventional name for the shared
   * chat-input Y.Text on each session's collab room.
   */
  const submitDraft = useCallback(
    async (yText: Y.Text) => {
      const text = yText.toString()
      if (text.length === 0) {
        return { ok: true, sent: false }
      }
      const doc = yText.doc
      // Snapshot + optimistic clear. Wrap both ends in a transaction so
      // peers see a single atomic update.
      const clear = () => {
        const len = yText.length
        if (len > 0) yText.delete(0, len)
      }
      const restore = () => {
        // Only re-insert if nobody has typed anything in the meantime;
        // otherwise we'd double-insert. If the text is non-empty, leave
        // whatever the users have since written in place and drop the
        // snapshot — the user will see the toast and can retry.
        if (yText.length === 0) yText.insert(0, text)
      }
      if (doc) doc.transact(clear)
      else clear()

      const submitId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

      // Dev-only test hook for VP2 (draft-restored-on-failure verification).
      // Skip the RPC entirely and treat it as a failure so the rollback
      // path runs end-to-end. Gated on the vite DEV flag + the window flag
      // so production bundles can't accidentally skip sends.
      const viteEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env
      const mockFailure =
        viteEnv?.DEV === true &&
        typeof window !== 'undefined' &&
        (window as unknown as { __mockSendFailure?: boolean }).__mockSendFailure === true

      if (mockFailure) {
        if (doc) doc.transact(restore)
        else restore()
        return { ok: false, sent: false, error: 'mock failure' }
      }

      const optimisticId = `usr-optimistic-${Date.now()}`
      optimisticIdsRef.current.add(optimisticId)
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          role: 'user',
          parts: contentToParts(text),
          createdAt: new Date(),
        },
      ])

      try {
        const result = (await connection.call('sendMessage', [text, { submitId }])) as {
          ok: boolean
          error?: string
        }
        if (!result.ok) {
          optimisticIdsRef.current.delete(optimisticId)
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
          if (doc) doc.transact(restore)
          else restore()
          return { ok: false, sent: false, error: result.error }
        }
        return { ok: true, sent: true }
      } catch (err) {
        optimisticIdsRef.current.delete(optimisticId)
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
        if (doc) doc.transact(restore)
        else restore()
        return {
          ok: false,
          sent: false,
          error: err instanceof Error ? err.message : 'send failed',
        }
      }
    },
    [connection],
  )

  const forkWithHistory = useCallback(
    async (content: string | ContentBlock[]) => {
      const optimisticId = `usr-optimistic-${Date.now()}`
      optimisticIdsRef.current.add(optimisticId)
      setMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          role: 'user',
          parts: contentToParts(content),
          createdAt: new Date(),
        },
      ])
      const result = (await connection.call('forkWithHistory', [content])) as {
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
