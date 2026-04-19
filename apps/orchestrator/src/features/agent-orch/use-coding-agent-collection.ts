/**
 * Prototype hook for the /debug/session-collection route — isolated test of
 * R1 from planning/research/2026-04-18-session-tab-loading-trace.md §6:
 * "flip messagesCollection to render source".
 *
 * Differences from ~/features/agent-orch/use-coding-agent.ts:
 *   - NO React useState<SessionMessage[]> — the collection is the source.
 *   - NO cacheSeededRef one-shot seed dance — useLiveQuery subscribes
 *     directly to the persisted collection.
 *   - NO knownEventUuidsRef / optimisticIdsRef tracking — upsert-by-id via
 *     collection.has(k) ? update(k,…) : insert(row) handles dedup; optimistic
 *     rollback is collection.delete(optId).
 *   - Scope-cut: only messages, state, and sendMessage. No kata state, no
 *     branch navigation, no rewind / forkWithHistory / context-usage.
 *     Production hook keeps those; the prototype only needs to prove the
 *     message render path.
 *
 * Lag probe marks are attached in onMessage (ws.received) and, on the
 * renderer side, in a useLayoutEffect per row (dom.painted). See
 * ./debug/lag-probe.ts for the measurement surface.
 *
 * This hook IS NOT wired to production code. It only runs inside the
 * dev-gated /debug/session-collection route.
 */

import { useAgent } from 'agents/react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'
import { useMessagesCollection } from '~/hooks/use-messages-collection'
import { contentToParts } from '~/lib/message-parts'
import type { ContentBlock, SessionMessage, SessionState } from '~/lib/types'
import { markWsReceived } from './debug/lag-probe'

export interface UseCodingAgentCollectionResult {
  state: SessionState | null
  /** Messages read live from messagesCollection (filtered by sessionId). */
  messages: SessionMessage[]
  isHydrated: boolean
  isConnecting: boolean
  sendMessage: (content: string | ContentBlock[]) => Promise<{ ok: boolean; error?: string }>
}

function toRow(msg: SessionMessage, sessionId: string): CachedMessage & Record<string, unknown> {
  return {
    id: msg.id,
    sessionId,
    role: msg.role,
    parts: msg.parts,
    createdAt: msg.createdAt,
  } as CachedMessage & Record<string, unknown>
}

function toSessionMessage(row: CachedMessage): SessionMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.parts,
    createdAt: row.createdAt ? new Date(row.createdAt as string) : undefined,
  } as SessionMessage
}

export function useCodingAgentCollection(agentName: string): UseCodingAgentCollectionResult {
  const [state, setState] = useState<SessionState | null>(null)
  const hydratedRef = useRef(false)
  const prevAgentNameRef = useRef(agentName)

  // Per-agentName collection (memoised inside the factory).
  const messagesCollection = useMemo(() => createMessagesCollection(agentName), [agentName])

  // Reset per-session refs on tab switch without remount.
  if (prevAgentNameRef.current !== agentName) {
    prevAgentNameRef.current = agentName
    hydratedRef.current = false
    setState(null)
  }

  // Render source: live query on the persisted collection, filtered to this session.
  const { messages: cachedMessages } = useMessagesCollection(agentName)
  const messages: SessionMessage[] = cachedMessages.map(toSessionMessage)

  /** Upsert-by-id into the collection. Dedup and echo-replacement baked in. */
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
        // Swallow — mutation API throws on rare contention; next frame will retry.
      }
    },
    [agentName, messagesCollection],
  )

  const bulkUpsert = useCallback(
    (msgs: SessionMessage[]) => {
      for (const m of msgs) upsert(m)
    },
    [upsert],
  )

  const connection = useAgent<SessionState>({
    agent: 'session-agent',
    name: agentName,
    onStateUpdate: (newState) => {
      setState(newState)
      if (!hydratedRef.current) {
        // Hydrate once via RPC — mirrors production path so the cold-DO race
        // (§4 L3) is represented. Difference: results land in the collection,
        // not setMessages.
        hydrateToCollection(connection)
          .then((n) => {
            if (n > 0) {
              hydratedRef.current = true
            } else if (newState.sdk_session_id) {
              setTimeout(() => {
                hydrateToCollection(connection)
                  .then((n2) => {
                    if (n2 > 0) hydratedRef.current = true
                  })
                  .catch(() => {})
              }, 500)
            } else {
              hydratedRef.current = true
            }
          })
          .catch(() => {})
      }
    },
    onMessage: (evt) => {
      try {
        const parsed = JSON.parse(typeof evt.data === 'string' ? evt.data : '')

        if (parsed.type === 'message' && parsed.message) {
          const msg = parsed.message as SessionMessage
          markWsReceived(msg.id)
          upsert(msg)
          return
        }

        if (parsed.type === 'messages' && Array.isArray(parsed.messages)) {
          const msgs = parsed.messages as SessionMessage[]
          for (const m of msgs) markWsReceived(m.id)
          bulkUpsert(msgs)
          hydratedRef.current = true
          return
        }
      } catch {
        // Non-JSON frames handled by onStateUpdate; ignore here.
      }
    },
  })

  async function hydrateToCollection(conn: typeof connection): Promise<number> {
    const hints = { session_hint: agentName }
    const serverMessages = (await conn.call('getMessages', [{ ...hints }])) as SessionMessage[]
    if (serverMessages.length > 0) bulkUpsert(serverMessages)
    return serverMessages.length
  }

  const sendMessage = useCallback(
    async (content: string | ContentBlock[]) => {
      const optId = `usr-optimistic-${Date.now()}`
      try {
        messagesCollection.insert({
          id: optId,
          sessionId: agentName,
          role: 'user',
          parts: contentToParts(content),
          createdAt: new Date(),
        } as CachedMessage & Record<string, unknown>)
      } catch {
        // Duplicate optimistic id — extremely unlikely but swallow.
      }
      const result = (await connection.call('sendMessage', [content])) as {
        ok: boolean
        error?: string
      }
      if (!result.ok) {
        try {
          messagesCollection.delete(optId)
        } catch {
          // already gone
        }
      }
      // On success: the server echo arrives via onMessage with the canonical
      // id. The optimistic row remains until reconciled. A simple reconciler
      // would delete rows whose id starts with 'usr-optimistic-' once a
      // matching server echo lands; for the prototype we leave it visible so
      // V4 / V5 behavior is easy to eyeball.
      return result
    },
    [connection, agentName, messagesCollection],
  )

  return {
    state,
    messages,
    isHydrated: hydratedRef.current,
    isConnecting: state === null && !hydratedRef.current,
    sendMessage,
  }
}
