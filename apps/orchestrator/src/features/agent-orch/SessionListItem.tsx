/**
 * SessionListItem — Renders a single session entry in the sidebar.
 */

import { MoreHorizontalIcon } from 'lucide-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { cn } from '~/lib/utils'
import type { SessionRecord } from './use-agent-orch-sessions'

interface SessionListItemProps {
  session: SessionRecord
  isSelected: boolean
  onClick: () => void
  onArchive?: (archived: boolean) => void
}

const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  aborted: 'destructive',
  idle: 'outline',
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function SessionListItem({ session, isSelected, onClick, onArchive }: SessionListItemProps) {
  const status = session.status || 'idle'

  return (
    <div className={cn('flex items-center gap-1', session.archived && 'opacity-50')}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'min-w-0 flex-1 rounded-md border px-2 py-1 text-left text-sm transition-colors hover:bg-accent',
          isSelected && 'border-primary bg-accent',
        )}
      >
        <div className="flex items-center justify-between">
          <span className="truncate font-medium">{session.id.slice(0, 12)}</span>
          <div className="ml-2 flex shrink-0 items-center gap-1">
            {session.archived && <span className="text-xs text-muted-foreground">archived</span>}
            <Badge variant={STATUS_VARIANTS[status] ?? 'outline'}>{status}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {session.created_at && <span>{formatTimeAgo(session.created_at)}</span>}
          {(session.num_turns ?? 0) > 0 && <span>{session.num_turns} turns</span>}
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="size-6 shrink-0 p-0"
            aria-label="Session options"
          >
            <MoreHorizontalIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onArchive?.(!session.archived)}>
            {session.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
