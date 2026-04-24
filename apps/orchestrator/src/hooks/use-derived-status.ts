/**
 * useDerivedStatus — derive the current session status purely from the
 * messages collection, without relying on D1-mirrored state or TTL-based
 * staleness checks.
 *
 * Companion to `useDerivedGate`: while that hook extracts the active
 * gate payload, this hook collapses messages into a single
 * `SessionStatus` value (`'idle' | 'running' | 'waiting_gate'`).
 *
 * Scans messages tail-first (newest → oldest) so the first terminal or
 * in-flight marker encountered is the authoritative status. Returns
 * `undefined` when the collection is empty or no recognisable marker is
 * found (e.g. session just created, no turns yet).
 *
 * GH#76 P5 tiebreaker: compares the local max `seq` from the messages
 * collection against `session.messageSeq` (D1-mirrored). If D1 has
 * caught up (serverSeq >= localMaxSeq), returns `undefined` so callers
 * fall through to `session?.status`. This prevents stale local messages
 * from overriding a fresher D1 status after reconnect.
 */

import { useMemo } from 'react'
import type { SessionMessagePart, SessionStatus } from '~/lib/types'
import { useMessagesCollection } from './use-messages-collection'
import { useSession } from './use-sessions-collection'

export function useDerivedStatus(sessionId: string | null): SessionStatus | undefined {
  const { messages } = useMessagesCollection(sessionId ?? '')
  const session = useSession(sessionId)

  return useMemo(() => {
    if (!messages || messages.length === 0) return undefined

    // Compute max seq from local messages
    let localMaxSeq = -1
    for (const msg of messages) {
      const seq = (msg as { seq?: number }).seq ?? -1
      if (seq > localMaxSeq) localMaxSeq = seq
    }

    // If the D1 row has caught up (or leads), fall through to session?.status
    const serverSeq = (session?.messageSeq ?? -1) as number
    if (serverSeq >= localMaxSeq) return undefined

    // D1 is stale — derive from messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      for (const part of (msg.parts as SessionMessagePart[] | undefined) ?? []) {
        if (part.type === 'awaiting_response' && (part as { state?: string }).state === 'pending') {
          return 'pending'
        }

        if (part.type === 'result') {
          return 'idle'
        }

        const state = (part as { state?: string }).state
        if (
          (part.type === 'tool-permission' || part.type === 'tool-ask_user') &&
          state === 'approval-requested'
        ) {
          return 'waiting_gate'
        }

        if (part.type === 'text' && state === 'streaming') {
          return 'running'
        }
      }
    }

    return undefined
  }, [messages, session])
}
