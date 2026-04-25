/**
 * useDerivedGate — derive the active tool-permission/ask_user gate from
 * messages, not SessionState.gate. Resolves Bug 3 (stale `ask_user` prompt
 * after approve/deny because SessionState.gate wasn't being cleared).
 *
 * Scans messages backwards (newest-first) so the first match is the most
 * recent pending gate. No fixed scan window — the old 20-message limit
 * silently dropped gates in long sessions, making them invisible to the
 * user while the agent sat blocked waiting for an answer.
 *
 * When the tool-result arrives and mutates the part's state to
 * 'approval-given' / 'approval-denied', this hook returns null in the same
 * live-query tick — no server-state race.
 */

import { useMemo } from 'react'
import type { SessionMessagePart } from '~/lib/types'
import { useMessagesCollection } from './use-messages-collection'

export interface DerivedGatePayload {
  /** toolCallId — what `resolveGate` RPC takes as its gateId. */
  id: string
  type: 'permission_request' | 'ask_user'
  /** The raw part for inline resolver rendering. */
  part: SessionMessagePart
}

/**
 * Predicate matching every gate part shape the UI must treat as "pending":
 *   - `tool-permission + approval-requested` (legacy permission_request)
 *   - `tool-ask_user + approval-requested` (legacy AskUserQuestion promotion)
 *   - `tool-AskUserQuestion + input-available` (SDK-native shape)
 * Mirrors ChatThread's `isPendingGate`. Exported so the Stop-button
 * "wedged-from-idle" wiring in AgentDetailView can share the predicate
 * without re-deriving the truthy gate payload.
 */
export function isPendingGatePart(part: SessionMessagePart): boolean {
  const state = (part as { state?: string }).state
  const toolCallId = (part as { toolCallId?: string }).toolCallId
  if (!toolCallId) return false
  if (
    (part.type === 'tool-permission' || part.type === 'tool-ask_user') &&
    state === 'approval-requested'
  ) {
    return true
  }
  if (part.type === 'tool-AskUserQuestion' && state === 'input-available') {
    return true
  }
  return false
}

export function useDerivedGate(sessionId: string): DerivedGatePayload | null {
  const { messages } = useMessagesCollection(sessionId)

  return useMemo(() => {
    if (!messages || messages.length === 0) return null
    // Scan backwards — gates are almost always near the tail, so this
    // terminates quickly in the common case. No `.slice()` allocation.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      for (const part of (msg.parts as SessionMessagePart[] | undefined) ?? []) {
        if (!isPendingGatePart(part)) continue
        const toolCallId = (part as { toolCallId?: string }).toolCallId as string
        // Both `tool-ask_user` (legacy) and `tool-AskUserQuestion` (SDK-native)
        // collapse to the `ask_user` resolver type — only `tool-permission`
        // is the permission gate.
        return {
          id: toolCallId,
          type: part.type === 'tool-permission' ? 'permission_request' : 'ask_user',
          part,
        }
      }
    }
    return null
  }, [messages])
}
