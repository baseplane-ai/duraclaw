/**
 * Transient per-session live state — WS readyState + DO-authoritative status.
 * Written by use-coding-agent's readyState effect and frame handler;
 * read by deriveDisplayStateFromStatus, status-bar, and other "is this
 * session's bridge live right now?" consumers.
 *
 * Local-only, no persistence, no sync, no server echo. Disappears on
 * reload. Spec #37 B11.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { onUserStreamReconnect, subscribeUserStream } from '~/hooks/use-user-stream'
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

/**
 * Subscribe to `session_status` deltas on the user-stream (UserSettingsDO).
 * Fired by the SessionDO's `broadcastStatusToOwner()` on every status
 * transition — covers background sessions (sidebar, tab bar) that don't
 * have a per-session WS connection. Writes to `sessionLocalCollection` so
 * `useSessionStatus()` reactively updates for all sessions.
 *
 * Module-level subscription — safe to register before the WS opens.
 */
if (typeof window !== 'undefined') {
  // On user-stream reconnect, clear cached status from all local rows so
  // consumers fall back to D1 `session?.status` until the next DO push
  // arrives. Without this, a session that stayed `running` throughout the
  // disconnect would show stale pre-disconnect status forever (no
  // transition → no delta → no update). Active sessions re-populate
  // immediately from the next WS frame; background sessions re-populate
  // when the DO pushes the next `session_status` delta.
  onUserStreamReconnect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionLocalCollection as any
    try {
      // Iterate optimisticUpserts (the live row map for local-only collections)
      // and clear status on each row. wsReadyState/wsCloseTs are unaffected.
      const items = coll._state?.optimisticUpserts as Map<string, SessionLocalState> | undefined
      if (items) {
        for (const [id, item] of items) {
          if (item.status !== undefined) {
            coll.update(id, (draft: { status: SessionStatus | undefined }) => {
              draft.status = undefined
            })
          }
        }
      }
    } catch {
      // collection not ready — no-op
    }
  })

  subscribeUserStream('session_status', (frame: SyncedCollectionFrame<unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionLocalCollection as any
    for (const op of frame.ops) {
      if (op.type === 'delete') continue
      const row = op.value as { id?: string; status?: string }
      if (!row?.id || !row?.status) continue
      try {
        coll.update(row.id, (draft: { status: string }) => {
          draft.status = row.status as string
        })
      } catch {
        coll.insert({
          id: row.id,
          wsReadyState: 3,
          wsCloseTs: null,
          status: row.status as SessionStatus,
        })
      }
    }
  })
}

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
