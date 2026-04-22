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

export function useDerivedGate(sessionId: string): DerivedGatePayload | null {
  const { messages } = useMessagesCollection(sessionId)

  return useMemo(() => {
    if (!messages || messages.length === 0) return null
    // Scan backwards — gates are almost always near the tail, so this
    // terminates quickly in the common case. No `.slice()` allocation.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      for (const part of (msg.parts as SessionMessagePart[] | undefined) ?? []) {
        const state = (part as { state?: string }).state
        const toolCallId = (part as { toolCallId?: string }).toolCallId
        if (
          (part.type === 'tool-permission' || part.type === 'tool-ask_user') &&
          state === 'approval-requested' &&
          toolCallId
        ) {
          return {
            id: toolCallId,
            type: part.type === 'tool-permission' ? 'permission_request' : 'ask_user',
            part,
          }
        }
      }
    }
    return null
  }, [messages])
}
