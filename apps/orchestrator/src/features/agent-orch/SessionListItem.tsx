/**
 * SessionListItem — Renders a single session entry in the sidebar.
 *
 * Chat-list style: status dot, title, time-ago, preview line,
 * turns/cost secondary info, right-click context menu.
 *
 * Mobile gestures: swipe-left to archive, long-press for context menu.
 */

import { ArchiveIcon, EditIcon, GitForkIcon, TagIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import type { SessionRecord } from '~/db/sessions-collection'
import { cn } from '~/lib/utils'
import { formatCost, formatTimeAgo, getPreviewText, StatusDot } from './session-utils'

interface SessionListItemProps {
  session: SessionRecord
  isSelected: boolean
  onClick: () => void
  onArchive?: (archived: boolean) => void
  onRename?: (title: string) => void
  onTag?: (tag: string | null) => void
  onFork?: () => void
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
  const numTurns = session.num_turns ?? 0
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [tagValue, setTagValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  const displayName = session.title || getPreviewText(session) || session.id.slice(0, 8)
  const preview = getPreviewText(session)

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

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setMenuOpen(true)
  }, [])

  // --- Mobile gesture state ---
  const SWIPE_THRESHOLD = 80
  const VERTICAL_DEADZONE = 30
  const LONG_PRESS_MS = 500
  const LONG_PRESS_MOVE_THRESHOLD = 10

  const [swipeX, setSwipeX] = useState(0)
  const [swiped, setSwiped] = useState(false)
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const gestureDecidedRef = useRef<'swipe' | 'scroll' | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  // Clean up timer on unmount
  useEffect(() => clearLongPress, [clearLongPress])

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
      gestureDecidedRef.current = null
      // Reset swipe if it was previously swiped open
      if (swiped) {
        setSwiped(false)
        setSwipeX(0)
      }

      // Start long-press timer
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        setMenuOpen(true)
        touchStartRef.current = null // prevent further gesture handling
      }, LONG_PRESS_MS)
    },
    [swiped],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current) return
      const touch = e.touches[0]
      const dx = touch.clientX - touchStartRef.current.x
      const dy = touch.clientY - touchStartRef.current.y
      const absDx = Math.abs(dx)
      const absDy = Math.abs(dy)

      // Cancel long-press if moved past threshold
      if (absDx > LONG_PRESS_MOVE_THRESHOLD || absDy > LONG_PRESS_MOVE_THRESHOLD) {
        clearLongPress()
      }

      // Decide gesture direction on first significant movement
      if (gestureDecidedRef.current === null && (absDx > 10 || absDy > 10)) {
        if (absDy > absDx) {
          // Vertical wins -> let scroll happen
          gestureDecidedRef.current = 'scroll'
          return
        }
        gestureDecidedRef.current = 'swipe'
      }

      if (gestureDecidedRef.current !== 'swipe') return

      // Only allow swipe-left (negative dx), clamp to prevent over-swipe
      if (dx < 0 && absDy < VERTICAL_DEADZONE) {
        const clampedX = Math.max(dx, -120)
        setSwipeX(clampedX)
      }
    },
    [clearLongPress],
  )

  const handleTouchEnd = useCallback(() => {
    clearLongPress()

    if (gestureDecidedRef.current === 'swipe' && swipeX < -SWIPE_THRESHOLD) {
      // Snap to reveal archive action
      setSwiped(true)
      setSwipeX(-SWIPE_THRESHOLD)
    } else {
      setSwipeX(0)
      setSwiped(false)
    }

    touchStartRef.current = null
    gestureDecidedRef.current = null
  }, [clearLongPress, swipeX])

  const handleSwipeArchive = useCallback(() => {
    onArchive?.(!session.archived)
    setSwiped(false)
    setSwipeX(0)
  }, [onArchive, session.archived])

  return (
    <>
      <div className={cn('relative overflow-hidden rounded-md', session.archived && 'opacity-50')}>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <span className="sr-only">Session options</span>
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

        {/* Swipe-reveal archive action (sits behind the button) */}
        {(swipeX < 0 || swiped) && (
          <button
            type="button"
            onClick={handleSwipeArchive}
            className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-destructive text-destructive-foreground text-xs font-medium"
          >
            <ArchiveIcon className="mr-1 size-3.5" />
            {session.archived ? 'Restore' : 'Archive'}
          </button>
        )}

        <button
          type="button"
          onClick={onClick}
          onContextMenu={handleContextMenu}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{
            transform: swipeX < 0 ? `translateX(${swipeX}px)` : undefined,
            transition: gestureDecidedRef.current === 'swipe' ? 'none' : 'transform 200ms ease-out',
          }}
          className={cn(
            'relative z-10 w-full rounded-md border bg-background px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent',
            isSelected && 'border-primary bg-accent',
          )}
        >
          {/* Row 1: dot + title + time-ago */}
          <div className="flex items-center gap-2">
            <StatusDot status={status} numTurns={numTurns} />
            <span className="min-w-0 flex-1 truncate font-medium">{displayName}</span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {session.tag && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  {session.tag}
                </Badge>
              )}
              {session.archived && <span className="text-xs text-muted-foreground">archived</span>}
              {session.updated_at && (
                <span className="text-xs text-muted-foreground">
                  {formatTimeAgo(session.updated_at)}
                </span>
              )}
            </div>
          </div>

          {/* Row 2: preview + turns/cost */}
          <div className="mt-0.5 flex items-center gap-2 pl-4">
            {preview && (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {preview}
              </span>
            )}
            {!preview && <span className="min-w-0 flex-1" />}
            <div className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              {numTurns > 0 && <span>{numTurns} turns</span>}
              {session.total_cost_usd != null && session.total_cost_usd > 0 && (
                <span>{formatCost(session.total_cost_usd)}</span>
              )}
            </div>
          </div>
        </button>
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
