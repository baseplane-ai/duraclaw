/**
 * useDerivedStatus — derive session status from messages, not SessionState.
 *
 * Replaces reading `state.status` from `sessionLiveStateCollection` with a
 * pure client-side derivation over the last ~10 messages. Resolves Bug 2
 * (stop/send button flips late when the server's `result` gateway_event is
 * delayed relative to the final assistant message).
 *
 * Rules (first match wins):
 *   1. Any `tool-permission` or `tool-ask_user` part with
 *      state==='approval-requested' → 'waiting_gate'
 *   2. Last message is an assistant with a trailing part in state 'streaming'
 *      → 'running'
 *   3. Last message is user (no server echo yet) → 'running'
 *   4. Otherwise → 'idle'
 *
 * Scans at most the last 10 messages (sorted by useMessagesCollection — i.e.
 * by wire seq, then turn ordinal, then createdAt). Memoised via TanStack DB
 * reactivity — the `useLiveQuery` inside `useMessagesCollection` re-runs this
 * hook on every mutation.
 */

import type { SessionStatus } from '@duraclaw/shared-types'
import { useMemo } from 'react'
import type { CachedMessage } from '~/db/messages-collection'
import type { SessionMessagePart } from '~/lib/types'
import { useMessagesCollection } from './use-messages-collection'

export function useDerivedStatus(sessionId: string): SessionStatus {
  const { messages } = useMessagesCollection(sessionId)

  return useMemo(() => {
    if (!messages || messages.length === 0) return 'idle'
    // Scan up to the last 10 from the tail. Gate check wins over all.
    const tail = messages.slice(-10)
    for (const msg of tail) {
      for (const part of (msg.parts as SessionMessagePart[] | undefined) ?? []) {
        if (
          (part.type === 'tool-permission' || part.type === 'tool-ask_user') &&
          (part as { state?: string }).state === 'approval-requested'
        ) {
          return 'waiting_gate'
        }
      }
    }
    const last = tail[tail.length - 1] as CachedMessage
    if (last.role === 'assistant') {
      const parts = (last.parts as SessionMessagePart[] | undefined) ?? []
      const lastPart = parts[parts.length - 1] as { state?: string } | undefined
      if (lastPart?.state === 'streaming') return 'running'
      return 'idle'
    }
    if (last.role === 'user') return 'running'
    return 'idle'
  }, [messages])
}
