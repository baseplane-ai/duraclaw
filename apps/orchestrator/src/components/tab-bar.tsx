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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SessionPresenceIcons } from '~/components/session-presence-icons'
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
import { type SessionLocalState, sessionLocalCollection } from '~/db/session-local-collection'
import type { SessionRecord } from '~/db/session-record'
import { getPreviewText, StatusDot } from '~/features/agent-orch/session-utils'
import { useIsMobile } from '~/hooks/use-mobile'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { isDraftTabId } from '~/hooks/use-tab-sync'
import { deriveStatus } from '~/lib/derive-status'
import { deriveDisplayStateFromStatus } from '~/lib/display-state'
import type { SessionStatus } from '~/lib/types'
import { useNow } from '~/lib/use-now'
import { cn } from '~/lib/utils'

interface TabBarProps {
  /** Ordered list of session IDs from userTabsCollection (ORDER BY position). */
  openTabs: string[]
  /** The session currently being viewed. */
  activeSessionId: string | null
  /**
   * {sessionId → project} map derived from userTabsCollection row meta.
   * Used to label draft tabs whose sessionId is not yet in the sessions
   * collection.
   */
  tabProjects?: Record<string, string | undefined>
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
  tabProjects,
  onSelectSession,
  onCloseTab,
  onReorder,
  onNewSessionInTab,
  onNewTabForProject,
}: TabBarProps) {
  // Include archived sessions so historical tabs (sessions the user archived
  // but still has open in their tab strip) continue to label correctly.
  const { sessions: allSessions } = useSessionsCollection({ includeArchived: true })

  const sessionsMap = useMemo(() => {
    const m = new Map<string, SessionRecord>()
    for (const row of allSessions) {
      m.set(row.id, row)
    }
    return m
  }, [allSessions])

  // Hoist `sessionLocalCollection` + `sessionsCollection` subscriptions to
  // the parent so N tabs share ONE live query each, not 2N. Perf: previously
  // every tab called `useSession(id)` + `useSessionLocalState(id)` →
  // any session/local update re-rendered all N tabs. Now only the affected
  // tab re-renders (because `ProjectTab` is `memo()`'d with shallow-compare
  // and gets its slice as a prop).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: localRows } = useLiveQuery(sessionLocalCollection as any)
  const sessionLocalsMap = useMemo(() => {
    const m = new Map<string, SessionLocalState>()
    for (const row of (localRows ?? []) as SessionLocalState[]) {
      m.set(row.id, row)
    }
    return m
  }, [localRows])

  // Build tab rows by joining openTabs with sessions.
  const rows = useMemo<TabRow[]>(
    () =>
      openTabs.map((tabId) => ({
        sessionId: tabId,
        session: sessionsMap.get(tabId),
      })),
    [openTabs, sessionsMap],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // ── Drag-to-reorder ──────────────────────────────────────────────
  const [activeDragId, setActiveDragId] = useState<string | null>(null)

  // Activation: 12px of pointer movement before a drag starts.
  //   - Click jitter under 12px no longer translates the tab + snaps back.
  //   - Above the long-press 10px move-cancel threshold below, so the two
  //     gestures compose cleanly: a stationary press still fires the
  //     long-press context menu after LONG_PRESS_MS, while moving past 12px
  //     unambiguously activates drag.
  // A delay-based constraint was tried first (`{ delay: 180, tolerance: 8 }`)
  // but it captured the touch before the 500ms long-press menu could fire.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 12 } }),
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

  // Translate vertical scroll-wheel → horizontal scroll in the tab strip.
  // Attach via a callback ref (not useEffect + empty deps) because the
  // scroll container is conditionally rendered — `rows.length === 0`
  // returns null, so `scrollRef.current` is null on the first effect run
  // and the `[]`-dep effect never re-runs when the element appears.
  // Must be non-passive because React registers onWheel as passive, and
  // passive listeners silently ignore preventDefault().
  const wheelCleanupRef = useRef<(() => void) | null>(null)
  const scrollCallbackRef = useCallback((el: HTMLDivElement | null) => {
    // Clean up previous listener
    wheelCleanupRef.current?.()
    wheelCleanupRef.current = null

    // Update the imperative ref other code relies on
    ;(scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el

    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      // Don't hijack scroll when there's nothing to scroll horizontally
      if (el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollBy({ left: e.deltaY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    wheelCleanupRef.current = () => el.removeEventListener('wheel', onWheel)
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
          ref={scrollCallbackRef}
          className="flex items-center border-b bg-background overflow-x-auto scrollbar-none"
        >
          <SortableContext items={openTabs} strategy={horizontalListSortingStrategy}>
            {rows.map((row) => {
              const draftProject = isDraftTabId(row.sessionId)
                ? tabProjects?.[row.sessionId]
                : undefined
              const menuProject = row.session?.project ?? draftProject
              return (
                <SortableProjectTab
                  key={row.sessionId}
                  sessionId={row.sessionId}
                  session={row.session}
                  liveLocal={sessionLocalsMap.get(row.sessionId)}
                  draftProject={draftProject}
                  isActive={row.sessionId === activeSessionId}
                  onSelect={() => onSelectSession(row.sessionId)}
                  onClose={() => onCloseTab(row.sessionId)}
                  onNewSessionInTab={
                    onNewSessionInTab && menuProject
                      ? () => onNewSessionInTab(menuProject)
                      : undefined
                  }
                  onNewTabForProject={
                    onNewTabForProject && menuProject
                      ? () => onNewTabForProject(menuProject)
                      : undefined
                  }
                />
              )
            })}
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
              liveLocal={sessionLocalsMap.get(activeDragRow.sessionId)}
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
  /** Transient WS readyState row for this session (hoisted from parent so
   *  each tab doesn't open its own `useSessionLocalState` subscription). */
  liveLocal?: SessionLocalState | undefined
  /** Project for a draft tab (no session row yet). */
  draftProject?: string | undefined
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

function ProjectTabInner({
  sessionId,
  session,
  liveLocal,
  draftProject,
  isActive,
  isDragging,
  onSelect,
  onClose,
  onNewSessionInTab,
  onNewTabForProject,
}: ProjectTabProps) {
  const isDraft = isDraftTabId(sessionId)
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)

  // Route tab status through `deriveDisplayStateFromStatus` so it agrees
  // with the status bar + sidebar.
  // Spec #37 P2b: status / numTurns come from the D1-mirrored
  // sessionsCollection row (= `session` prop, live-synced from the parent's
  // single `useSessionsCollection` subscription); wsReadyState from the
  // transient local row (= `liveLocal` prop, hoisted at the parent).
  // We no longer call `useSession()` / `useSessionLocalState()` here — that
  // opened 2N live-query subscriptions for N tabs and re-rendered every
  // tab on any session delta.
  // GH#50: feed TTL-derived status into the display mapper so stuck
  // `running` tabs degrade to `idle` in lockstep with StatusBar / sidebar.
  const nowTs = useNow()
  // Prefer DO-pushed live status → raw D1 (if WS not yet open) → TTL-derived.
  const wsOpen = (liveLocal?.wsReadyState ?? 3) === 1
  const d1Derived = session ? deriveStatus(session, nowTs) : undefined
  const rawD1 = session?.status as SessionStatus | undefined
  const liveStatus = liveLocal?.liveStatus as SessionStatus | undefined
  const sessionDerived = liveStatus ?? (!wsOpen ? rawD1 : undefined) ?? d1Derived
  const tabDisplay = deriveDisplayStateFromStatus(
    sessionDerived,
    liveLocal?.wsReadyState ?? 3,
    liveLocal?.wsCloseTs ?? null,
  )
  const tabStatus = tabDisplay.status !== 'unknown' ? tabDisplay.status : (sessionDerived ?? 'idle')
  const tabNumTurns = session?.numTurns ?? 0

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
          <StatusDot status={tabStatus} numTurns={tabNumTurns} />
          <SessionPresenceIcons sessionId={sessionId} />
          <div className="flex flex-col items-start min-w-0">
            <span className="text-[11px] text-muted-foreground leading-tight font-normal">
              {session.project}
            </span>
            <span className="max-w-32 truncate leading-tight">
              {session.title || getPreviewText(session) || session.project}
            </span>
          </div>
        </>
      ) : isDraft ? (
        <>
          <PlusIcon className="size-3 text-muted-foreground" />
          <div className="flex flex-col items-start min-w-0">
            {draftProject && (
              <span className="text-[11px] text-muted-foreground leading-tight font-normal">
                {draftProject}
              </span>
            )}
            <span className="max-w-32 truncate leading-tight italic text-muted-foreground">
              New session
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

  const headingProject = session?.project ?? (isDraft ? (draftProject ?? null) : null)
  const headingTitle = isDraft
    ? 'New session'
    : session?.title || session?.project || sessionId.slice(0, 8)

  const showNewSessionInTab = onNewSessionInTab
  const showNewTabForProject = onNewTabForProject

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
              {showNewSessionInTab && (
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-md px-3 py-3 text-sm text-left hover:bg-accent"
                  onClick={() => handleMenuAction(onNewSessionInTab)}
                >
                  <PlusIcon className="size-4" />
                  New session in tab
                </button>
              )}
              {showNewTabForProject && (
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
        {showNewSessionInTab && (
          <DropdownMenuItem onClick={() => handleMenuAction(onNewSessionInTab)}>
            <PlusIcon className="mr-2 size-3" />
            New session in tab
          </DropdownMenuItem>
        )}
        {showNewTabForProject && (
          <DropdownMenuItem onClick={() => handleMenuAction(onNewTabForProject)}>
            <CopyPlusIcon className="mr-2 size-3" />
            New tab for project
          </DropdownMenuItem>
        )}
        {(showNewSessionInTab || showNewTabForProject) && <DropdownMenuSeparator />}
        <DropdownMenuItem variant="destructive" onClick={() => handleMenuAction(onClose)}>
          <X className="mr-2 size-3" />
          Close tab
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Memoized ProjectTab — shallow-compares props. The parent now passes
 * `session` + `liveLocal` as stable references from `sessionsMap` /
 * `sessionLocalsMap`, so a tab only re-renders when its own session row
 * or its own transient local row actually changes.
 */
const ProjectTab = memo(ProjectTabInner)
