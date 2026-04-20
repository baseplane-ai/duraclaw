/**
 * useDerivedGate — derive the active tool-permission/ask_user gate from
 * messages, not SessionState.gate. Resolves Bug 3 (stale `ask_user` prompt
 * after approve/deny because SessionState.gate wasn't being cleared).
 *
 * Returns the first message part in state 'approval-requested' from a
 * recent scan window (last 20 messages). When the tool-result arrives and
 * mutates the part's state to 'approval-given' / 'approval-denied', this
 * hook returns null in the same live-query tick — no server-state race.
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
    const tail = messages.slice(-20)
    for (const msg of tail) {
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
