/**
 * useKanbanLanes — Yjs-backed lane collapse state for the /board kanban.
 *
 * Shares the same user-settings Y.Doc as useTabSync (guid
 * `user-settings:<userId>`). Stores a Y.Map<string> at key `kanbanLanes`;
 * values are JSON-encoded `{ collapsed: boolean }`.
 *
 * Cross-device sync is via UserSettingsDO + y-partyserver; local cold
 * start is served from y-indexeddb. Matches the mounting pattern of
 * useTabSync so the two hooks share the same provider/persistence when
 * used on the same page (two Y.Docs with the same guid merge).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'

interface LaneEntry {
  collapsed: boolean
}

function parseLane(val: unknown): LaneEntry {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val) as LaneEntry
      return { collapsed: Boolean(parsed?.collapsed) }
    } catch {
      return { collapsed: false }
    }
  }
  return { collapsed: false }
}

function buildLaneMap(lanesY: Y.Map<string>): Record<string, LaneEntry> {
  const out: Record<string, LaneEntry> = {}
  lanesY.forEach((val, key) => {
    out[key] = parseLane(val)
  })
  return out
}

export interface UseKanbanLanesResult {
  isCollapsed: (lane: string) => boolean
  toggle: (lane: string) => void
}

export function useKanbanLanes(): UseKanbanLanesResult {
  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const userId = session?.user?.id ?? null

  const doc = useMemo(() => {
    if (!userId) return null
    const d = new Y.Doc()
    d.guid = `user-settings:${userId}`
    return d
  }, [userId])

  const lanesY = useMemo(() => doc?.getMap<string>('kanbanLanes') ?? null, [doc])

  const host = typeof window !== 'undefined' && window.location ? window.location.host : ''

  useYProvider({
    host,
    room: userId ?? '',
    party: 'user-settings',
    doc: doc ?? undefined,
    options: { connect: Boolean(userId) },
  })

  // IndexedDB persistence for offline cold-start.
  useEffect(() => {
    if (!userId || !doc) return
    let destroyed = false
    let idb: { destroy: () => void } | null = null
    import('y-indexeddb').then(({ IndexeddbPersistence }) => {
      if (destroyed) return
      idb = new IndexeddbPersistence(`user-settings:${userId}`, doc)
    })
    return () => {
      destroyed = true
      idb?.destroy()
    }
  }, [userId, doc])

  const [lanes, setLanes] = useState<Record<string, LaneEntry>>(() =>
    lanesY ? buildLaneMap(lanesY) : {},
  )

  useEffect(() => {
    if (!lanesY) return
    const handler = () => {
      setLanes(buildLaneMap(lanesY))
    }
    lanesY.observe(handler)
    setLanes(buildLaneMap(lanesY))
    return () => lanesY.unobserve(handler)
  }, [lanesY])

  const isCollapsed = useCallback(
    (lane: string): boolean => Boolean(lanes[lane]?.collapsed),
    [lanes],
  )

  const toggle = useCallback(
    (lane: string) => {
      if (!doc || !lanesY) return
      doc.transact(() => {
        const current = parseLane(lanesY.get(lane))
        lanesY.set(lane, JSON.stringify({ collapsed: !current.collapsed }))
      })
    },
    [doc, lanesY],
  )

  return { isCollapsed, toggle }
}
