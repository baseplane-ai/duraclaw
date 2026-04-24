/**
 * Transient per-session live state — WS readyState only.
 * Written by use-coding-agent's readyState effect;
 * read by deriveDisplayStateFromStatus, status-bar, and other "is this
 * session's bridge live right now?" consumers.
 *
 * Local-only, no persistence, no sync, no server echo. Disappears on
 * reload. Spec #37 B11.
 */

import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'

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
