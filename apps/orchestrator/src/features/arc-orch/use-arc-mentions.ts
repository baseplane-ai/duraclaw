/**
 * GH#152 P1.5 WU-C — React hooks layered on `arcMentionsCollection`.
 *
 * `useInboxMentions` returns the user's mention feed sorted by
 * `mentionTs DESC`. `useUnreadMentionsCount` powers the global
 * Inbox/Notifications badge in the nav. `useInboxActions` POSTs the
 * per-row and bulk read endpoints; the server broadcasts updated rows
 * on the caller's `arcMentions` stream so all open tabs reconcile.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { type ArcMentionRow, arcMentionsCollection } from '~/db/arc-mentions-collection'
import { apiUrl } from '~/lib/platform'

export function useInboxMentions(): ArcMentionRow[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(arcMentionsCollection as any)

  return useMemo(() => {
    const rows = (data ?? []) as ArcMentionRow[]
    // Defensive copy — `data` is a live reference.
    return [...rows].sort((a, b) => b.mentionTs.localeCompare(a.mentionTs))
  }, [data])
}

export function useUnreadMentionsCount(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(arcMentionsCollection as any)

  return useMemo(() => {
    const rows = (data ?? []) as ArcMentionRow[]
    let n = 0
    for (const r of rows) if (r.readAt === null) n += 1
    return n
  }, [data])
}

export interface InboxActions {
  markRead: (mentionId: string) => Promise<{ ok: boolean; error?: string }>
  markAllRead: () => Promise<{ ok: boolean; error?: string; updated?: number }>
}

export function useInboxActions(): InboxActions {
  const markRead = useCallback(async (mentionId: string) => {
    try {
      const resp = await fetch(apiUrl(`/api/inbox/${encodeURIComponent(mentionId)}/read`), {
        method: 'POST',
      })
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

  const markAllRead = useCallback(async () => {
    try {
      const resp = await fetch(apiUrl('/api/inbox/read-all'), { method: 'POST' })
      if (!resp.ok) {
        let errMsg = `markAllRead ${resp.status}`
        try {
          const j = (await resp.json()) as { error?: string }
          if (j?.error) errMsg = j.error
        } catch {
          // fall through
        }
        return { ok: false, error: errMsg }
      }
      const j = (await resp.json().catch(() => ({}))) as { updated?: number }
      return { ok: true, updated: j.updated }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  return { markRead, markAllRead }
}
