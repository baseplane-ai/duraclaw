/**
 * SessionListItem — Renders a single session entry in the sidebar.
 */

import { EditIcon, GitForkIcon, MoreHorizontalIcon, TagIcon } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'
import type { SessionRecord } from './use-agent-orch-sessions'

interface SessionListItemProps {
  session: SessionRecord
  isSelected: boolean
  onClick: () => void
  onArchive?: (archived: boolean) => void
  onRename?: (title: string) => void
  onTag?: (tag: string | null) => void
  onFork?: () => void
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

export function SessionListItem({
  session,
  isSelected,
  onClick,
  onArchive,
  onRename,
  onTag,
  onFork,
}: SessionListItemProps) {
  const status = session.status || 'idle'
  const [renameOpen, setRenameOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [tagValue, setTagValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  const displayName = session.title || session.id.slice(0, 12)

  const handleRenameOpen = useCallback(() => {
    setRenameValue(session.title || '')
    setRenameOpen(true)
  }, [session.title])

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== session.title) {
      onRename?.(trimmed)
    }
    setRenameOpen(false)
  }, [renameValue, session.title, onRename])

  const handleTagOpen = useCallback(() => {
    setTagValue(session.tag || '')
    setTagOpen(true)
  }, [session.tag])

  const handleTagSubmit = useCallback(() => {
    const trimmed = tagValue.trim()
    onTag?.(trimmed || null)
    setTagOpen(false)
  }, [tagValue, onTag])

  return (
    <>
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
            <span className="truncate font-medium">{displayName}</span>
            <div className="ml-2 flex shrink-0 items-center gap-1">
              {session.tag && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  {session.tag}
                </Badge>
              )}
              {session.archived && <span className="text-xs text-muted-foreground">archived</span>}
              <Badge variant={STATUS_VARIANTS[status] ?? 'outline'}>{status}</Badge>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {session.created_at && <span>{formatTimeAgo(session.created_at)}</span>}
            {(session.num_turns ?? 0) > 0 && <span>{session.num_turns} turns</span>}
            {session.title && (
              <span className="truncate opacity-60" title={session.id}>
                {session.id.slice(0, 8)}
              </span>
            )}
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
            <DropdownMenuItem onClick={handleRenameOpen}>
              <EditIcon className="mr-2 size-3" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleTagOpen}>
              <TagIcon className="mr-2 size-3" />
              {session.tag ? 'Edit tag' : 'Add tag'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onFork?.()}>
              <GitForkIcon className="mr-2 size-3" />
              Fork
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onArchive?.(!session.archived)}>
              {session.archived ? 'Unarchive' : 'Archive'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Session title"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit()
            }}
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" onClick={handleRenameSubmit}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tag dialog */}
      <Dialog open={tagOpen} onOpenChange={setTagOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{session.tag ? 'Edit tag' : 'Add tag'}</DialogTitle>
          </DialogHeader>
          <Input
            ref={tagInputRef}
            value={tagValue}
            onChange={(e) => setTagValue(e.target.value)}
            placeholder="Tag (leave empty to remove)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTagSubmit()
            }}
            autoFocus
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            {session.tag && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  onTag?.(null)
                  setTagOpen(false)
                }}
              >
                Remove
              </Button>
            )}
            <Button size="sm" onClick={handleTagSubmit}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
