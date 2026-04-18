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
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
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
import { StatusDot } from '~/features/agent-orch/session-utils'
import { useIsMobile } from '~/hooks/use-mobile'
import { cn } from '~/lib/utils'

interface TabBarProps {
  /** Ordered list of session IDs from Yjs Y.Array. */
  openTabs: string[]
  /** The session currently being viewed. */
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onCloseTab: (sessionId: string) => void
  onReorder: (fromIndex: number, toIndex: number) => void
  onNewSessionInTab?: (project: string) => void
  onNewTabForProject?: (project: string) => void
}

interface TabRow {
  sessionId: string
  session: SessionRecord | undefined
}

export function TabBar({
  openTabs,
  activeSessionId,
  onSelectSession,
  onCloseTab,
  onReorder,
  onNewSessionInTab,
  onNewTabForProject,
}: TabBarProps) {
  // Fetch all sessions for display metadata join.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: allSessions } = useLiveQuery((q: any) =>
    q.from({ session: agentSessionsCollection }),
  )

  const sessionsMap = useMemo(() => {
    const m = new Map<string, SessionRecord>()
    if (!allSessions) return m
    for (const row of allSessions as SessionRecord[]) {
      m.set(row.id, row)
    }
    return m
  }, [allSessions])

  // Build tab rows by joining openTabs with sessions.
  const rows = useMemo<TabRow[]>(
    () => openTabs.map((sessionId) => ({ sessionId, session: sessionsMap.get(sessionId) })),
    [openTabs, sessionsMap],
  )

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
      const oldIndex = rows.findIndex((r) => r.sessionId === active.id)
      const newIndex = rows.findIndex((r) => r.sessionId === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      onReorder(oldIndex, newIndex)
    },
    [rows, onReorder],
  )

  const activeDragRow = activeDragId ? rows.find((r) => r.sessionId === activeDragId) : null

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

  // Re-check overflow when tab count changes
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
    const el = scrollRef.current.querySelector(
      `[data-tab-id="${activeSessionId}"]`,
    ) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeSessionId])

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
          <SortableContext items={openTabs} strategy={horizontalListSortingStrategy}>
            {rows.map((row) => (
              <SortableProjectTab
                key={row.sessionId}
                sessionId={row.sessionId}
                session={row.session}
                isActive={row.sessionId === activeSessionId}
                onSelect={() => onSelectSession(row.sessionId)}
                onClose={() => onCloseTab(row.sessionId)}
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

      {/* Drag preview overlay */}
      <DragOverlay dropAnimation={null}>
        {activeDragRow && (
          <div className="rounded border bg-background shadow-lg opacity-90">
            <ProjectTab
              sessionId={activeDragRow.sessionId}
              session={activeDragRow.session}
              isActive={activeDragRow.sessionId === activeSessionId}
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
  sessionId: string
  session: SessionRecord | undefined
  isActive: boolean
  isDragging?: boolean
  onSelect: () => void
  onClose: () => void
  onNewSessionInTab?: () => void
  onNewTabForProject?: () => void
}

/** Sortable wrapper */
function SortableProjectTab(props: ProjectTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.sessionId,
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
    if (longPressedRef.current) {
      longPressedRef.current = false
      return
    }
    onSelect()
  }, [onSelect])

  const a11yLabel = `tab ${sessionId.slice(0, 8)}`

  const tabContent = (
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
          <StatusDot status={session.status || 'idle'} numTurns={session.numTurns ?? 0} />
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
  )

  const handleMenuAction = useCallback((action: (() => void) | undefined) => {
    setMenuOpen(false)
    action?.()
  }, [])

  const headingProject = session?.project ?? null
  const headingTitle = session?.title || session?.project || sessionId.slice(0, 8)

  if (isMobile) {
    return (
      <>
        <div
          className="group relative flex items-center border-r select-none"
          data-tab-id={sessionId}
        >
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

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        className="group relative flex items-center border-r select-none"
        data-tab-id={sessionId}
      >
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
