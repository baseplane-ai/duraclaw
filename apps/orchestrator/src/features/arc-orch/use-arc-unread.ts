/**
 * GH#152 P1.5 WU-C — React hooks layered on `arcUnreadCollection`.
 *
 * `useArcUnread(arcId)` exposes the per-arc unread counters for the
 * current user (zeros when no row). `useTotalUnread` aggregates across
 * all rows for a tab-bar / nav badge. `useArcUnreadActions().markRead`
 * POSTs `/api/arcs/:id/read?kind=...` — the server clears the counter
 * and broadcasts the patched row on the caller's stream so all open
 * tabs / devices reconcile in place via the SyncedCollection delta
 * path.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { type ArcUnreadRow, arcUnreadCollection } from '~/db/arc-unread-collection'
import { apiUrl } from '~/lib/platform'

export interface ArcUnreadCounters {
  unreadComments: number
  unreadChat: number
}

const ZERO: ArcUnreadCounters = { unreadComments: 0, unreadChat: 0 }

export function useArcUnread(arcId: string): ArcUnreadCounters {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(arcUnreadCollection as any)

  return useMemo(() => {
    const rows = (data ?? []) as ArcUnreadRow[]
    const row = rows.find((r) => r.arcId === arcId)
    if (!row) return ZERO
    return {
      unreadComments: row.unreadComments ?? 0,
      unreadChat: row.unreadChat ?? 0,
    }
  }, [data, arcId])
}

export interface TotalUnread {
  totalComments: number
  totalChat: number
  totalCombined: number
}

export function useTotalUnread(): TotalUnread {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(arcUnreadCollection as any)

  return useMemo(() => {
    const rows = (data ?? []) as ArcUnreadRow[]
    let totalComments = 0
    let totalChat = 0
    for (const r of rows) {
      totalComments += r.unreadComments ?? 0
      totalChat += r.unreadChat ?? 0
    }
    return {
      totalComments,
      totalChat,
      totalCombined: totalComments + totalChat,
    }
  }, [data])
}

export interface MarkReadArgs {
  arcId: string
  kind: 'comments' | 'chat'
}

export interface ArcUnreadActions {
  markRead: (args: MarkReadArgs) => Promise<{ ok: boolean; error?: string }>
}

export function useArcUnreadActions(): ArcUnreadActions {
  const markRead = useCallback(async ({ arcId, kind }: MarkReadArgs) => {
    try {
      const resp = await fetch(
        apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/read?kind=${encodeURIComponent(kind)}`),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        },
      )
      if (!resp.ok) {
        let errMsg = `markRead ${resp.status}`
        try {
          const j = (await resp.json()) as { error?: string }
          if (j?.error) errMsg = j.error
        } catch {
          // fall through
        }
        return { ok: false, error: errMsg }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  return { markRead }
}
