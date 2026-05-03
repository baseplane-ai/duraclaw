/**
 * GH#152 P1.5 WU-D — global @-mention Inbox surface.
 *
 * Reads `arcMentionsCollection` (sorted by `mentionTs DESC` via
 * `useInboxMentions`) and `arcsCollection` (for arc title resolution
 * without an extra fetch). Filter chips toggle Unread / All with Unread
 * as the default — the spec calls out this as the productive default
 * since an inbox loaded with previously-cleared mentions is noise.
 *
 * Per-row "Mark read" + global "Mark all read" go through
 * `useInboxActions`; the server broadcasts the patched rows on the
 * caller's `arcMentions` stream, so all open tabs reconcile in place.
 *
 * Visual density mirrors `TeamChatPanel` — `text-sm`, dividers via
 * `border-b border-border`, light hover on rows.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { Link } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import type { ArcMentionRow } from '~/db/arc-mentions-collection'
import { arcsCollection } from '~/db/arcs-collection'
import type { ArcSummary } from '~/lib/types'
import { cn } from '~/lib/utils'
import { useInboxActions, useInboxMentions } from '../arc-orch/use-arc-mentions'

type Filter = 'unread' | 'all'

function relativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diffMs = Date.now() - t
  if (diffMs < 60_000) return 'just now'
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

interface MentionRowViewProps {
  mention: ArcMentionRow
  arcTitle: string | null
  onMarkRead: (id: string) => void
}

function MentionRowView({ mention, arcTitle, onMarkRead }: MentionRowViewProps) {
  const isUnread = mention.readAt === null

  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-b border-border px-3 py-2 text-sm hover:bg-muted/40',
        isUnread && 'bg-muted/20',
      )}
      data-testid="inbox-mention-row"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {isUnread && (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full bg-primary"
              data-testid="inbox-unread-dot"
            />
          )}
          <span className="font-medium">{mention.actorUserId}</span>
          <span className="text-muted-foreground">in</span>
          <Link
            to="/arc/$arcId"
            params={{ arcId: mention.arcId }}
            className="truncate underline-offset-2 hover:underline"
            title={arcTitle ?? mention.arcId}
          >
            {arcTitle ?? mention.arcId}
          </Link>
          <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground">
            {mention.sourceKind}
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(mention.mentionTs)}
        </span>
      </div>
      <Link
        to="/arc/$arcId"
        params={{ arcId: mention.arcId }}
        className="block text-muted-foreground hover:text-foreground"
      >
        {mention.preview}
      </Link>
      {isUnread && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onMarkRead(mention.id)}
            data-testid="inbox-mark-read"
          >
            Mark read
          </Button>
        </div>
      )}
    </div>
  )
}

export function MentionsList() {
  const mentions = useInboxMentions()
  const { markRead, markAllRead } = useInboxActions()
  const [filter, setFilter] = useState<Filter>('unread')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: arcsData } = useLiveQuery(arcsCollection as any)

  const arcTitleByArcId = useMemo(() => {
    const map = new Map<string, string>()
    const arcs = (arcsData ?? []) as ArcSummary[]
    for (const a of arcs) map.set(a.id, a.title)
    return map
  }, [arcsData])

  const filtered = useMemo(() => {
    if (filter === 'all') return mentions
    return mentions.filter((m) => m.readAt === null)
  }, [mentions, filter])

  const unreadCount = useMemo(
    () => mentions.reduce((n, m) => (m.readAt === null ? n + 1 : n), 0),
    [mentions],
  )

  const handleMarkRead = useCallback(
    async (id: string) => {
      const res = await markRead(id)
      if (!res.ok) toast.error(res.error ?? 'Failed to mark read')
    },
    [markRead],
  )

  const handleMarkAllRead = useCallback(async () => {
    const res = await markAllRead()
    if (!res.ok) toast.error(res.error ?? 'Failed to mark all read')
  }, [markAllRead])

  const isEmpty = filtered.length === 0
  const emptyMessage =
    filter === 'unread' && mentions.length > 0 ? 'All caught up!' : 'No mentions yet'

  return (
    <div className="flex h-full flex-col" data-testid="inbox-mentions-list">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={filter === 'unread' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setFilter('unread')}
            data-testid="inbox-filter-unread"
          >
            Unread
            {unreadCount > 0 && (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
                {unreadCount}
              </span>
            )}
          </Button>
          <Button
            type="button"
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setFilter('all')}
            data-testid="inbox-filter-all"
          >
            All
          </Button>
        </div>
        {unreadCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleMarkAllRead}
            data-testid="inbox-mark-all-read"
          >
            Mark all read
          </Button>
        )}
      </div>

      {isEmpty ? (
        <div
          className="flex flex-1 items-center justify-center px-3 py-12 text-sm text-muted-foreground"
          data-testid="inbox-empty"
        >
          {emptyMessage}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {filtered.map((m) => (
            <MentionRowView
              key={m.id}
              mention={m}
              arcTitle={arcTitleByArcId.get(m.arcId) ?? null}
              onMarkRead={handleMarkRead}
            />
          ))}
        </div>
      )}
    </div>
  )
}
