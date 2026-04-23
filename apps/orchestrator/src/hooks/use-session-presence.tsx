/**
 * SessionPresenceProvider — aggregates y-partyserver awareness across every
 * session the current user has as an open tab. Exposes a single
 * `useSessionPresence(sessionId)` hook so tab rows and sidebar rows can
 * render "who else is here" icons without each one opening its own WS.
 *
 * Architecture:
 *   - Reads `openTabs` from `userTabsCollection` via `useLiveQuery`.
 *   - For every open sessionId, mounts a `<SessionPresenceObserver />`
 *     which opens a read-only `useYProvider` against the `session-collab`
 *     party and publishes the dedup'd peer list (excluding self) into a
 *     shared context map.
 *   - The observer does NOT `setLocalState`. Publishing presence to peers
 *     stays the responsibility of `useSessionCollab` in the active tab,
 *     so "I'm in session X" semantics are unchanged — background tabs
 *     observe but don't broadcast themselves.
 *
 * Sessions not open as tabs return an empty array — sidebar rows for
 * unopened sessions render no icons.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { userTabsCollection } from '~/db/user-tabs-collection'
import { useSession } from '~/lib/auth-client'
import { partyHost } from '~/lib/platform'
import type { UserTabRow } from '~/lib/types'

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
 *  mounting the full provider + YProvider stack. */
export const SessionPresenceCtxForTests = SessionPresenceCtx

interface PeerState {
  user?: { id?: string; name?: string; color?: string }
}

function readPeers(awareness: Awareness, selfUserId: string | null): PresencePeer[] {
  const states = awareness.getStates() as Map<number, PeerState>
  const byUserId = new Map<string, PresencePeer>()
  for (const state of states.values()) {
    const id = state.user?.id
    if (!id) continue
    if (id === selfUserId) continue
    if (byUserId.has(id)) continue
    byUserId.set(id, {
      id,
      name: state.user?.name ?? 'Anonymous',
      color: state.user?.color ?? '#94a3b8',
    })
  }
  return Array.from(byUserId.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function peersEqual(a: PresencePeer[], b: PresencePeer[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].name !== b[i].name || a[i].color !== b[i].color) return false
  }
  return true
}

interface ObserverProps {
  sessionId: string
  selfUserId: string | null
  onChange: (sessionId: string, peers: PresencePeer[]) => void
  onUnmount: (sessionId: string) => void
}

function SessionPresenceObserver({ sessionId, selfUserId, onChange, onUnmount }: ObserverProps) {
  // Fresh throwaway doc per sessionId — we only need this provider for
  // the awareness side-channel; the ytext sync is along for the ride.
  const doc = useMemo(() => {
    const d = new Y.Doc()
    d.guid = `session-presence-observer:${sessionId}`
    return d
  }, [sessionId])
  const host = partyHost()
  const provider = useYProvider({ host, room: sessionId, party: 'session-collab', doc })

  useEffect(() => {
    if (!provider) return
    const awareness = provider.awareness as Awareness
    const publish = () => onChange(sessionId, readPeers(awareness, selfUserId))
    publish()
    awareness.on('change', publish)
    return () => {
      awareness.off('change', publish)
    }
  }, [provider, sessionId, selfUserId, onChange])

  useEffect(() => {
    return () => onUnmount(sessionId)
  }, [sessionId, onUnmount])

  return null
}

interface ProviderProps {
  children: React.ReactNode
}

export function SessionPresenceProvider({ children }: ProviderProps) {
  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const selfUserId = session?.user?.id ?? null

  // TanStack DB beta generics don't perfectly match the NonSingleResult
  // overload; matches the cast in use-tab-sync.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(userTabsCollection as any)
  const openSessionIds = useMemo(() => {
    const rows = (data as UserTabRow[] | undefined) ?? []
    const seen = new Set<string>()
    const ids: string[] = []
    for (const row of rows) {
      const sid = row.sessionId
      if (!sid) continue
      if (seen.has(sid)) continue
      seen.add(sid)
      ids.push(sid)
    }
    return ids
  }, [data])

  const [presence, setPresence] = useState<PresenceMap>(EMPTY_MAP)

  const handleChange = useCallback((sessionId: string, peers: PresencePeer[]) => {
    setPresence((prev) => {
      const existing = prev.get(sessionId) ?? EMPTY
      if (peersEqual(existing, peers)) return prev
      const next = new Map(prev)
      next.set(sessionId, peers)
      return next
    })
  }, [])

  const handleUnmount = useCallback((sessionId: string) => {
    setPresence((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  return (
    <SessionPresenceCtx.Provider value={presence}>
      {openSessionIds.map((sessionId) => (
        <SessionPresenceObserver
          key={sessionId}
          sessionId={sessionId}
          selfUserId={selfUserId}
          onChange={handleChange}
          onUnmount={handleUnmount}
        />
      ))}
      {children}
    </SessionPresenceCtx.Provider>
  )
}

export function useSessionPresence(sessionId: string): PresencePeer[] {
  const map = useContext(SessionPresenceCtx)
  return map.get(sessionId) ?? EMPTY
}
