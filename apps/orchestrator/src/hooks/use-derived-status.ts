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
 *   2. Last message is an assistant with ANY part in an active state —
 *      'streaming' (text/reasoning deltas still arriving) or
 *      'input-available' (tool_use emitted, waiting for tool_result from
 *      the runner) — → 'running'. The pre-fix version only looked at the
 *      tail part's `state === 'streaming'`, so a finalized assistant that
 *      ended on a `tool-*` part in `input-available` (the canonical
 *      mid-turn wedge: SDK waiting on a long-running tool) read as idle
 *      and the stop button disappeared exactly when users wanted it.
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
      // Any active-state part (streaming deltas OR a tool waiting on its
      // result) means the runner still has work in flight. Check all parts,
      // not just the tail — a finalized assistant commonly looks like
      // `[text(done), tool(input-available)]` while the SDK is blocked on
      // the tool_result round-trip.
      for (const part of parts) {
        const state = (part as { state?: string }).state
        if (state === 'streaming' || state === 'input-available') return 'running'
      }
      return 'idle'
    }
    if (last.role === 'user') return 'running'
    return 'idle'
  }, [messages])
}
