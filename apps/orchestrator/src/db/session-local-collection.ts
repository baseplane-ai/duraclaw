/**
 * Transient per-session live state — WS readyState + DO-authoritative status.
 * Written by use-coding-agent's readyState effect and frame handler;
 * read by deriveDisplayStateFromStatus, status-bar, and other "is this
 * session's bridge live right now?" consumers.
 *
 * Local-only, no persistence, no sync, no server echo. Disappears on
 * reload. Spec #37 B11.
 */

import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { SessionStatus } from '~/lib/types'

export interface SessionLocalState {
  id: string
  wsReadyState: number
  /**
   * GH#69 B5: epoch-ms of the last OPEN→!OPEN transition. Cleared to `null`
   * when readyState transitions back to OPEN. Consumed by
   * `deriveDisplayStateFromStatus` to suppress the DISCONNECTED flash during
   * the 5s ConnectionManager reconnect window. Transient / not persisted.
   */
  wsCloseTs: number | null
  /**
   * DO-authoritative session status, extracted from every `messages:*` WS
   * frame's `sessionStatus` field. The DO stamps this on every frame, so
   * the client always has the latest status without any derivation fold or
   * D1 tiebreaker. Replaces `useDerivedStatus`.
   *
   * `undefined` before the first WS frame arrives (cold-start); callers
   * fall back to `session?.status` (D1 row) in that case only.
   */
  status?: SessionStatus
}

export const sessionLocalCollection = createCollection(
  localOnlyCollectionOptions<SessionLocalState, string>({
    id: 'session_local',
    getKey: (item) => item.id,
  }),
)

export function useSessionLocalState(
  sessionId: string | null | undefined,
): SessionLocalState | undefined {
  // TanStack DB beta: collection generic doesn't align with NonSingleResult
  // constraint on the useLiveQuery overload. Runtime is correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(sessionLocalCollection as any)
  if (!sessionId || !data) return undefined
  return (data as SessionLocalState[]).find((r) => r.id === sessionId)
}

/**
 * DO-authoritative session status. Reads `sessionStatus` from the latest WS
 * frame (written to `sessionLocalCollection` by the frame handler in
 * `use-coding-agent.ts`). Falls back to `session?.status` (D1 row) before the
 * first WS frame arrives (cold-start only).
 *
 * Replaces `useDerivedStatus` — no message-fold, no tiebreaker, no derivation.
 */
export function useSessionStatus(sessionId: string | null | undefined): SessionStatus | undefined {
  const local = useSessionLocalState(sessionId)
  return local?.status
}
