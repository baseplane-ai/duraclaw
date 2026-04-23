/**
 * Transient per-session live state — WS readyState + DO-pushed live status.
 * Written by use-coding-agent's readyState effect and onMessage handler;
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
   * DO-pushed live status — bypasses D1 round-trip for active sessions.
   * Set by the `{type:'session_status'}` frame from the agent WS; cleared
   * on WS close so display falls back to D1 + TTL predicate. Fixes the
   * "idle while streaming" race where D1 lastEventTs lags behind the
   * debounced flush.
   */
  liveStatus?: SessionStatus | null
  /** DO-pushed gate — null when no gate is pending. */
  liveGate?: { type: string; id: string; detail?: unknown } | null
  /** DO-pushed error — null when no error. */
  liveError?: string | null
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
