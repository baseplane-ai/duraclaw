import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { ChevronLeftIcon, ChevronRightIcon, CopyPlusIcon, PlusIcon, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { agentSessionsCollection, type SessionRecord } from '~/db/agent-sessions-collection'
import { userTabsCollection } from '~/db/user-tabs-collection'
import { StatusDot } from '~/features/agent-orch/session-utils'
import { setActiveTabId } from '~/hooks/use-active-tab'
import { useIsMobile } from '~/hooks/use-mobile'
import type { UserTabRow } from '~/lib/types'
import { cn } from '~/lib/utils'

interface TabBarProps {
  /** The session currently being viewed — drives tab highlighting. Derived from URL. */
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onLastTabClosed?: () => void
  onNewSessionInTab?: (project: string) => void
  onNewTabForProject?: (project: string) => void
}

interface JoinedRow {
  tab: UserTabRow
  session: SessionRecord | undefined
}

export function TabBar({
  activeSessionId,
  onSelectSession,
  onLastTabClosed,
  onNewSessionInTab,
  onNewTabForProject,
}: TabBarProps) {
  // Live join: tab × session (LEFT JOIN — session may be undefined while
  // agentSessionsCollection is hydrating). Sorted by tab.position so user
  // drag-reordering is reflected without per-render sort work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: joinData } = useLiveQuery((q: any) =>
    q
      .from({ tab: userTabsCollection })
      .leftJoin({ session: agentSessionsCollection }, ({ tab, session }: any) =>
        eq(tab.sessionId, session.id),
      )
      .orderBy(({ tab }: any) => tab.position),
  )

  const rows = useMemo<JoinedRow[]>(() => {
    if (!joinData) return []
    return joinData as unknown as JoinedRow[]
  }, [joinData])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // ── Drag-to-reorder ──────────────────────────────────────────────
  const [activeDragId, setActiveDragId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveDragId(String(e.active.id))
  }, [])

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveDragId(null)
      const { active, over } = e
      if (!over || active.id === over.id) return
      const oldIndex = rows.findIndex((r) => r.tab.id === active.id)
      const newIndex = rows.findIndex((r) => r.tab.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      const reordered = arrayMove(rows, oldIndex, newIndex)
      const orderedIds = reordered.map((r) => r.tab.id)
      // Persist via the dedicated reorder endpoint, then refetch so positions
      // resync from D1. Optimistic UI is provided by dnd-kit's transform.
      fetch('/api/user-settings/tabs/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      })
        .then((resp) => {
          if (resp.ok) {
            userTabsCollection.utils.refetch().catch(() => {})
          }
        })
        .catch(() => {})
    },
    [rows],
  )

  const activeDragRow = activeDragId ? rows.find((r) => r.tab.id === activeDragId) : null

  // Detect overflow on scroll + resize
  const updateOverflow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateOverflow()
    el.addEventListener('scroll', updateOverflow, { passive: true })
    const ro = new ResizeObserver(updateOverflow)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateOverflow)
      ro.disconnect()
    }
  }, [updateOverflow])

  // Re-check overflow when tab count changes (DOM mutation won't trigger ResizeObserver on the container)
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows.length intentionally triggers re-check
  useEffect(updateOverflow, [updateOverflow, rows.length])

  const scrollBy = useCallback((dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  // Translate vertical scroll-wheel → horizontal scroll in the tab strip
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY === 0) return
    e.preventDefault()
    scrollRef.current?.scrollBy({ left: e.deltaY })
  }, [])

  // Scroll active tab into view when it changes
  useEffect(() => {
    if (!activeSessionId || !scrollRef.current) return
    const activeRow = rows.find((r) => r.tab.sessionId === activeSessionId)
    if (!activeRow) return
    const el = scrollRef.current.querySelector(
      `[data-tab-id="${activeRow.tab.id}"]`,
    ) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeSessionId, rows])

  const handleClose = useCallback(
    (tabId: string) => {
      const isLastTab = rows.length === 1
      if (userTabsCollection.has(tabId)) {
        userTabsCollection.delete([tabId])
      }
      if (isLastTab && onLastTabClosed) {
        onLastTabClosed()
      } else {
        const remaining = rows.filter((r) => r.tab.id !== tabId)
        if (remaining.length > 0) {
          const idx = rows.findIndex((r) => r.tab.id === tabId)
          const next = remaining[Math.min(idx, remaining.length - 1)]
          setActiveTabId(next.tab.id)
          if (next.tab.sessionId) {
            onSelectSession(next.tab.sessionId)
          }
        }
      }
    },
    [rows, onSelectSession, onLastTabClosed],
  )

  if (rows.length === 0) return null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="relative" data-testid="tab-bar">
        <div
          ref={scrollRef}
          className="flex items-center border-b bg-background overflow-x-auto scrollbar-none"
          onWheel={handleWheel}
        >
          <SortableContext
            items={rows.map((r) => r.tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            {rows.map((row) => (
              <SortableProjectTab
                key={row.tab.id}
                tabId={row.tab.id}
                sessionId={row.tab.sessionId}
                session={row.session}
                isActive={row.tab.sessionId === activeSessionId}
                onSelect={() => {
                  setActiveTabId(row.tab.id)
                  if (row.tab.sessionId) {
                    onSelectSession(row.tab.sessionId)
                  }
                }}
                onClose={() => handleClose(row.tab.id)}
                onNewSessionInTab={
                  onNewSessionInTab && row.session?.project
                    ? () => onNewSessionInTab(row.session?.project as string)
                    : undefined
                }
                onNewTabForProject={
                  onNewTabForProject && row.session?.project
                    ? () => onNewTabForProject(row.session?.project as string)
                    : undefined
                }
              />
            ))}
          </SortableContext>
        </div>

        {/* Scroll overflow arrows */}
        {canScrollLeft && (
          <button
            type="button"
            aria-label="Scroll tabs left"
            className="absolute left-0 top-0 bottom-0 z-10 flex items-center pl-0.5 pr-1 bg-gradient-to-r from-background via-background/80 to-transparent"
            onClick={() => scrollBy('left')}
          >
            <ChevronLeftIcon className="size-3.5 text-muted-foreground" />
          </button>
        )}
        {canScrollRight && (
          <button
            type="button"
            aria-label="Scroll tabs right"
            className="absolute right-0 top-0 bottom-0 z-10 flex items-center pr-0.5 pl-1 bg-gradient-to-l from-background via-background/80 to-transparent"
            onClick={() => scrollBy('right')}
          >
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Drag preview overlay — renders a floating copy of the dragged tab */}
      <DragOverlay dropAnimation={null}>
        {activeDragRow && (
          <div className="rounded border bg-background shadow-lg opacity-90">
            <ProjectTab
              tabId={activeDragRow.tab.id}
              sessionId={activeDragRow.tab.sessionId}
              session={activeDragRow.session}
              isActive={activeDragRow.tab.sessionId === activeSessionId}
              onSelect={() => {}}
              onClose={() => {}}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

interface ProjectTabProps {
  tabId: string
  sessionId: string | null
  session: SessionRecord | undefined
  isActive: boolean
  isDragging?: boolean
  onSelect: () => void
  onClose: () => void
  onNewSessionInTab?: () => void
  onNewTabForProject?: () => void
}

/** Sortable wrapper — applies dnd-kit transform/transition and drag listeners */
function SortableProjectTab(props: ProjectTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.tabId,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: 'relative',
    zIndex: isDragging ? 1 : 0,
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ProjectTab {...props} isDragging={isDragging} />
    </div>
  )
}

function ProjectTab({
  tabId,
  sessionId,
  session,
  isActive,
  isDragging,
  onSelect,
  onClose,
  onNewSessionInTab,
  onNewTabForProject,
}: ProjectTabProps) {
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)

  // Close context menu when a drag starts (long-press may have opened it)
  useEffect(() => {
    if (isDragging) setMenuOpen(false)
  }, [isDragging])

  // --- Long-press + right-click menu trigger ---
  const LONG_PRESS_MS = 500
  const LONG_PRESS_MOVE_THRESHOLD = 10

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const longPressedRef = useRef(false)

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  useEffect(() => clearLongPress, [clearLongPress])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setMenuOpen(true)
  }, [])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
    longPressedRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      longPressedRef.current = true
      setMenuOpen(true)
    }, LONG_PRESS_MS)
  }, [])

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current) return
      const touch = e.touches[0]
      const dx = Math.abs(touch.clientX - touchStartRef.current.x)
      const dy = Math.abs(touch.clientY - touchStartRef.current.y)
      if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
        clearLongPress()
      }
    },
    [clearLongPress],
  )

  const handleTouchEnd = useCallback(() => {
    clearLongPress()
    touchStartRef.current = null
  }, [clearLongPress])

  const handleSelectClick = useCallback(() => {
    // Swallow the click that follows a long-press so we don't also select the tab.
    if (longPressedRef.current) {
      longPressedRef.current = false
      return
    }
    onSelect()
  }, [onSelect])

  // Skeleton state: tab row exists but the joined session hasn't hydrated yet
  // (or `tab.sessionId` is null). Render a shimmer placeholder so the tab bar
  // never shows the literal word "unknown" or the raw session id.
  const a11yLabel = sessionId ? `tab ${sessionId.slice(0, 8)}` : `tab ${tabId.slice(0, 8)}`

  const tabContent = (
    <>
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent',
          isActive && 'bg-accent text-accent-foreground',
        )}
        onClick={handleSelectClick}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        aria-label={a11yLabel}
      >
        {session ? (
          <>
            <StatusDot status={session.status || 'idle'} numTurns={session.num_turns ?? 0} />
            <div className="flex flex-col items-start min-w-0">
              <span className="text-[11px] text-muted-foreground leading-tight font-normal">
                {session.project}
              </span>
              <span className="max-w-32 truncate leading-tight">
                {session.title || session.project}
              </span>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-start min-w-0 gap-1 py-0.5">
            <div className="animate-pulse bg-muted h-2 w-12 rounded" />
            <div className="animate-pulse bg-muted h-3 w-20 rounded" />
          </div>
        )}
      </button>
    </>
  )

  const handleMenuAction = useCallback((action: (() => void) | undefined) => {
    setMenuOpen(false)
    action?.()
  }, [])

  // Heading text used in mobile sheet / context menu — avoids the word "unknown"
  // when the session hasn't hydrated yet by falling back to the tab id snippet.
  const headingProject = session?.project ?? null
  const headingTitle = session?.title || session?.project || tabId.slice(0, 8)

  // On mobile, render a bottom Sheet (popup modal) for easier viewing / tapping.
  if (isMobile) {
    return (
      <>
        <div className="group relative flex items-center border-r select-none" data-tab-id={tabId}>
          {tabContent}
        </div>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="bottom" className="pb-6">
            <SheetHeader>
              <SheetTitle className="text-sm">
                {headingProject && (
                  <span className="text-muted-foreground font-normal">{headingProject} · </span>
                )}
                {headingTitle}
              </SheetTitle>
              <SheetDescription className="sr-only">Tab actions</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-1 px-2 pb-2">
              {onNewSessionInTab && (
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-md px-3 py-3 text-sm text-left hover:bg-accent"
                  onClick={() => handleMenuAction(onNewSessionInTab)}
                >
                  <PlusIcon className="size-4" />
                  New session in tab
                </button>
              )}
              {onNewTabForProject && (
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-md px-3 py-3 text-sm text-left hover:bg-accent"
                  onClick={() => handleMenuAction(onNewTabForProject)}
                >
                  <CopyPlusIcon className="size-4" />
                  New tab for project
                </button>
              )}
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                className="flex items-center gap-3 rounded-md px-3 py-3 text-sm text-left text-destructive hover:bg-destructive/10"
                onClick={() => handleMenuAction(onClose)}
              >
                <X className="size-4" />
                Close tab
              </button>
            </div>
          </SheetContent>
        </Sheet>
      </>
    )
  }

  // Desktop: right-click dropdown menu.
  // Use a hidden trigger so Radix doesn't add click-to-open on the tab itself.
  // The menu is controlled entirely via the `open` state set by onContextMenu / long-press.
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <div className="group relative flex items-center border-r select-none" data-tab-id={tabId}>
        {tabContent}
        <DropdownMenuTrigger
          className="absolute inset-0 appearance-none bg-transparent pointer-events-none"
          tabIndex={-1}
          aria-hidden
        />
      </div>
      <DropdownMenuContent align="start">
        {onNewSessionInTab && (
          <DropdownMenuItem onClick={() => handleMenuAction(onNewSessionInTab)}>
            <PlusIcon className="mr-2 size-3" />
            New session in tab
          </DropdownMenuItem>
        )}
        {onNewTabForProject && (
          <DropdownMenuItem onClick={() => handleMenuAction(onNewTabForProject)}>
            <CopyPlusIcon className="mr-2 size-3" />
            New tab for project
          </DropdownMenuItem>
        )}
        {(onNewSessionInTab || onNewTabForProject) && <DropdownMenuSeparator />}
        <DropdownMenuItem variant="destructive" onClick={() => handleMenuAction(onClose)}>
          <X className="mr-2 size-3" />
          Close tab
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
