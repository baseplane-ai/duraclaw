/**
 * SessionPresenceProvider — derives "who else has this session open as a
 * tab?" from the D1-backed `session_viewers` synced collection.
 *
 * Architecture (GH#87 follow-up):
 *   - The `session_viewers` collection is maintained server-side: every
 *     `user_tabs` insert/patch/delete triggers `fanoutSessionViewerChange`,
 *     which recomputes viewer lists and broadcasts per-user delta frames
 *     via `UserSettingsDO`. The client applies them through the standard
 *     synced-collection WS channel (same as tabs, preferences, projects).
 *   - The provider subscribes via `useLiveQuery(sessionViewersCollection)`
 *     and maps the rows into a `Map<sessionId, PresencePeer[]>`, adding
 *     `colorForUserId` on the client side (deterministic, no server
 *     round-trip).
 *   - Components consume the data through `useSessionPresence(sessionId)`.
 *
 * This replaces the prior y-partyserver awareness-based approach, which
 * only showed "actively viewing" peers (observer tabs didn't broadcast)
 * and opened one WS per open tab per user. The D1-backed model shows
 * everyone who has the session open as a tab, with zero extra WS
 * connections — it rides the existing user-stream channel.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { createContext, useContext, useMemo } from 'react'
import { sessionViewersCollection } from '~/db/session-viewers-collection'
import { colorForUserId } from '~/lib/presence-colors'
import type { SessionViewerRow } from '~/lib/types'

export interface PresencePeer {
  id: string
  name: string
  color: string
}

type PresenceMap = ReadonlyMap<string, PresencePeer[]>

const EMPTY: PresencePeer[] = []
const EMPTY_MAP: PresenceMap = new Map()

const SessionPresenceCtx = createContext<PresenceMap>(EMPTY_MAP)

/** Exported only for tests that render `<SessionPresenceIcons>` without
 *  mounting the full provider + collection stack. */
export const SessionPresenceCtxForTests = SessionPresenceCtx

interface ProviderProps {
  children: React.ReactNode
}

export function SessionPresenceProvider({ children }: ProviderProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(sessionViewersCollection as any)
  const rows = (data as SessionViewerRow[] | undefined) ?? []

  const presence = useMemo<PresenceMap>(() => {
    if (rows.length === 0) return EMPTY_MAP
    const map = new Map<string, PresencePeer[]>()
    for (const row of rows) {
      if (row.viewers.length === 0) continue
      const peers: PresencePeer[] = row.viewers
        .map((v) => ({
          id: v.userId,
          name: v.name || 'Anonymous',
          color: colorForUserId(v.userId),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      map.set(row.sessionId, peers)
    }
    return map
  }, [rows])

  return <SessionPresenceCtx.Provider value={presence}>{children}</SessionPresenceCtx.Provider>
}

export function useSessionPresence(sessionId: string): PresencePeer[] {
  const map = useContext(SessionPresenceCtx)
  return map.get(sessionId) ?? EMPTY
}
