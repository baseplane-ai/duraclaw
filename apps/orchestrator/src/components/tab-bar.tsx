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
import type { ProjectInfo } from '@duraclaw/shared-types'
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
import { projectsCollection } from '~/db/projects-collection'
import { useSessionStatus } from '~/db/session-local-collection'
import type { SessionRecord } from '~/db/session-record'
import { userTabsCollection } from '~/db/user-tabs-collection'
import { useIsMobile } from '~/hooks/use-mobile'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { isDraftTabId } from '~/hooks/use-tab-sync'
import { deriveTabDisplayState } from '~/lib/display-state'
import {
  deriveProjectAbbrev,
  deriveProjectColorSlot,
  deriveRepoBase,
  deriveSessionSuffix,
  type ProjectColorSlot,
  parseWorktreeSuffix,
  statusRingClass,
} from '~/lib/project-display'
import type { SessionStatus, TabMeta, UserTabRow } from '~/lib/types'
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
  /** From `user_tabs.meta.lastSeenSeq`; undefined for draft/unsynced rows. */
  lastSeenSeq: number | undefined
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

  // Tab meta subscription — drives the `completed_unseen` derivation.
  // Each `user_tabs` row carries a `TabMeta` JSON blob; we project it to
  // `{sessionId → {rowId, lastSeenSeq}}` so the render loop can look up
  // per-tab state in O(1) without parsing JSON on every tab.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawTabRows } = useLiveQuery((q) => q.from({ t: userTabsCollection as any }))
  const tabMetaByRef = useMemo(() => {
    const m = new Map<string, { rowId: string; lastSeenSeq: number | undefined }>()
    for (const r of (rawTabRows ?? []) as unknown as UserTabRow[]) {
      if ((r as { deletedAt?: string | null }).deletedAt) continue
      if (!r.sessionId) continue
      let parsed: TabMeta = {}
      if (r.meta) {
        try {
          const v = JSON.parse(r.meta)
          if (v && typeof v === 'object') parsed = v as TabMeta
        } catch {
          /* keep default */
        }
      }
      m.set(r.sessionId, { rowId: r.id, lastSeenSeq: parsed.lastSeenSeq })
    }
    return m
  }, [rawTabRows])

  // Mark-seen effect — when the active tab changes OR its backing session
  // transitions (most importantly running → idle while you're watching),
  // bump `meta.lastSeenSeq` to the session's current `messageSeq` so the
  // tab does NOT flip to `completed_unseen` after you switch away.
  //
  // Deps list is narrow on purpose: `[activeSessionId, activeStatus,
  // activeRowId, activeLastSeen]`. We deliberately do NOT depend on the
  // raw `messageSeq` — during a streaming turn it ticks on every event
  // frame, and PATCHing once per frame would be ~50 writes per turn. Only
  // re-firing on status transitions bounds PATCHes to O(turns). When
  // status flips to `idle`, the session's messageSeq has already advanced
  // to its terminal value by definition, so the snapshot is accurate.
  const activeSession = activeSessionId ? sessionsMap.get(activeSessionId) : undefined
  const activeStatus = activeSession?.status
  const activeSessionSeq = activeSession?.messageSeq ?? -1
  const activeTabMeta = activeSessionId ? tabMetaByRef.get(activeSessionId) : undefined
  const activeRowId = activeTabMeta?.rowId
  const activeLastSeen = activeTabMeta?.lastSeenSeq ?? -1
  useEffect(() => {
    if (!activeSessionId || !activeRowId) return
    // Gate on `status === 'idle'` so we only PATCH at turn-boundaries.
    // During a streaming turn messageSeq bumps per event frame (~50/turn);
    // deferring the snapshot to idle clamps writes to O(turns). The user
    // is watching the active tab while it's running, so everything
    // through the idle transition is implicitly "seen" — we just need to
    // commit the terminal seq when it lands.
    if (activeStatus !== 'idle') return
    if (activeSessionSeq <= activeLastSeen) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = userTabsCollection as any
    coll.update(activeRowId, (draft: UserTabRow) => {
      // Re-parse so we don't clobber sibling meta fields (project, kind).
      let current: TabMeta = {}
      if (draft.meta) {
        try {
          const v = JSON.parse(draft.meta)
          if (v && typeof v === 'object') current = v as TabMeta
        } catch {
          /* keep default */
        }
      }
      const next: TabMeta = { ...current, lastSeenSeq: activeSessionSeq }
      const out: TabMeta = {}
      if (next.kind) out.kind = next.kind
      if (next.project !== undefined) out.project = next.project
      if (typeof next.lastSeenSeq === 'number') out.lastSeenSeq = next.lastSeenSeq
      draft.meta = JSON.stringify(out)
    })
  }, [activeSessionId, activeStatus, activeRowId, activeSessionSeq, activeLastSeen])

  // Build tab rows by joining openTabs with sessions.
  const rows = useMemo<TabRow[]>(
    () =>
      openTabs.map((tabId) => ({
        sessionId: tabId,
        session: sessionsMap.get(tabId),
        lastSeenSeq: tabMetaByRef.get(tabId)?.lastSeenSeq,
      })),
    [openTabs, sessionsMap, tabMetaByRef],
  )

  // Projects map: project name → repo_origin. Used to key the color slot
  // so the 4 worktrees of one repo all share the same fill color.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectRows } = useLiveQuery((q) => q.from({ p: projectsCollection as any }))
  const repoOriginByProject = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const p of (projectRows ?? []) as unknown as ProjectInfo[]) {
      m.set(p.name, p.repo_origin)
    }
    return m
  }, [projectRows])

  // Siblings-in-worktree map: sessionId → ordered list of sibling session
  // IDs that share its `project` (= worktree). Sort by `createdAt` so the
  // `a/b/c` suffix assignment stays stable across renders.
  const siblingsBySession = useMemo(() => {
    const byProject = new Map<string, SessionRecord[]>()
    for (const row of rows) {
      if (!row.session) continue
      const arr = byProject.get(row.session.project) ?? []
      arr.push(row.session)
      byProject.set(row.session.project, arr)
    }
    const m = new Map<string, string[]>()
    for (const arr of byProject.values()) {
      arr.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      const ids = arr.map((s) => s.id)
      for (const s of arr) m.set(s.id, ids)
    }
    return m
  }, [rows])

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

  // Detect overflow on scroll + resize.
  //
  // Two sources of residue push `scrollLeft + clientWidth` below `scrollWidth`
  // even when no further scrolling is possible, so the naive `<` comparison
  // strands the right chevron at the true scroll end:
  //
  //   1. Every `ProjectTab` has `m-0.5` (2 px margin on all sides). Chrome
  //      includes the last tab's 2 px trailing margin in `scrollWidth` but
  //      clamps max `scrollLeft` so that margin never scrolls into the
  //      viewport — `scrollLeft + clientWidth` tops out 2 px short.
  //   2. HiDPI displays and CSS zoom leave the extents sub-pixel rounded,
  //      adding up to ~1 px of residue on top.
  //
  // A 4 px tolerance is wider than any real "scroll nudge" would be, so it
  // only triggers a false negative when the user genuinely can't scroll
  // further — the "more" chevron then reliably hides at scroll end.
  const updateOverflow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(Math.floor(el.scrollLeft) > 0)
    setCanScrollRight(Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 4)
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
      <div className="relative flex-1 min-w-0 h-full" data-testid="tab-bar">
        <div
          ref={scrollCallbackRef}
          className="flex h-full items-center border-b bg-background overflow-x-auto scrollbar-none"
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
                  draftProject={draftProject}
                  siblingIds={siblingsBySession.get(row.sessionId) ?? [row.sessionId]}
                  repoOrigin={
                    row.session ? (repoOriginByProject.get(row.session.project) ?? null) : null
                  }
                  isActive={row.sessionId === activeSessionId}
                  lastSeenSeq={row.lastSeenSeq}
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
              siblingIds={
                siblingsBySession.get(activeDragRow.sessionId) ?? [activeDragRow.sessionId]
              }
              repoOrigin={
                activeDragRow.session
                  ? (repoOriginByProject.get(activeDragRow.session.project) ?? null)
                  : null
              }
              isActive={activeDragRow.sessionId === activeSessionId}
              lastSeenSeq={activeDragRow.lastSeenSeq}
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
  /** Project for a draft tab (no session row yet). */
  draftProject?: string | undefined
  /** Sessions sharing this tab's worktree, ordered stably; drives the
   *  `a/b/c` letter suffix. Length 1 → no suffix. */
  siblingIds?: readonly string[]
  /** `repo_origin` of the session's project. Used as the color-slot key
   *  so sibling worktrees of the same repo share a fill color. Null when
   *  the project isn't in the synced projects collection yet. */
  repoOrigin?: string | null
  isActive: boolean
  isDragging?: boolean
  /** Highest `messageSeq` the user has acknowledged for this tab (from
   *  `user_tabs.meta.lastSeenSeq`). Undefined for draft tabs / rows not
   *  yet synced. Together with `session.messageSeq` + `session.status`
   *  drives the `completed_unseen` ring color. */
  lastSeenSeq?: number
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
  draftProject,
  siblingIds,
  repoOrigin,
  isActive,
  isDragging,
  lastSeenSeq,
  onSelect,
  onClose,
  onNewSessionInTab,
  onNewTabForProject,
}: ProjectTabProps) {
  const isDraft = isDraftTabId(sessionId)
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)

  // Tab-strip status dot: prefer `useSessionStatus(id)` — the DO-authoritative
  // status pushed over the always-on user-stream WS via
  // `broadcastStatusToOwner` (`session_status` collection → sessionLocalCollection).
  // Falls back to the D1-mirrored `agent_sessions.status` for cold-start before
  // the first DO push lands. Post the ea01ca5 refactor, D1 `agent_sessions.status`
  // is no longer written on transitions (only at result-time, always 'idle'),
  // so reading the D1 row alone leaves the tab dot stuck on its cold-start
  // value through every mid-session running / waiting_gate transition.
  //
  // Do NOT gate on per-session `wsReadyState` here — background tabs'
  // PartySockets legitimately close to save resources, and the server's
  // session status is still authoritative and fresh over the user-stream
  // rail. The per-session-WS "Reconnecting…" signal belongs to the active
  // session's StatusBar / DisconnectedBanner, not the N-tab fleet view.
  //
  // Promotion to `completed_unseen` — when the server says `idle` but the
  // user hasn't activated this tab since the session's last event, the
  // ring recolors sky ("Done — hasn't been viewed"). Derivation is purely
  // local; the server stores only `messageSeq` + `lastSeenSeq`. wsReadyState
  // is passed as `1` (OPEN) because the per-tab WS doesn't gate the fleet
  // view (see comment above) — we deliberately short-circuit the
  // disconnect grace logic in `deriveDisplayStateFromStatus`.
  const doStatus = useSessionStatus(sessionId)
  const rawStatus = doStatus ?? (session?.status as SessionStatus | undefined) ?? 'idle'
  const tabDisplay = deriveTabDisplayState({
    status: rawStatus,
    wsReadyState: 1,
    isActive,
    sessionMessageSeq: session?.messageSeq,
    lastSeenSeq,
  })
  const tabStatus = tabDisplay.status

  // Dense label — abbrev + worktree-N + optional a/b suffix.
  // Project color keyed by `repo_origin` so sibling worktrees of the same
  // repo share a fill; falls back to the repo base name when the project
  // isn't in the synced collection yet (cold start / draft tab).
  const tabProjectName = session?.project ?? draftProject ?? ''
  const repoBase = deriveRepoBase(tabProjectName)
  const abbrev = deriveProjectAbbrev(repoBase)
  const worktreeN = parseWorktreeSuffix(tabProjectName, repoBase)
  const sessionLetter = deriveSessionSuffix(sessionId, siblingIds ?? [sessionId])
  const denseLabel = `${abbrev}${worktreeN}${sessionLetter}`
  const colorSlot: ProjectColorSlot = deriveProjectColorSlot(repoOrigin || repoBase || null)
  const ringClass = statusRingClass(tabStatus)

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

  // Dense tab: project-color fill, status-color ring, abbrev+N[+letter]
  // label, optional session title on desktop only. Replaces the prior
  // StatusDot + project + preview trio — status now lives in the ring and
  // summary text has moved to the status bar.
  const tabContent = (
    <button
      type="button"
      className={cn(
        'relative flex items-center justify-center gap-1.5 min-w-12 px-2 py-1 m-0.5 text-xs font-medium rounded-sm',
        'transition-all',
        colorSlot.bg,
        colorSlot.text,
        isActive
          ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
          : cn(ringClass, 'opacity-75 hover:opacity-100'),
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
          <span className={cn('font-mono tracking-tight', isActive && 'font-semibold')}>
            {denseLabel}
          </span>
          {!isMobile && session.title && (
            <span className="max-w-40 truncate font-normal opacity-90">{session.title}</span>
          )}
          <SessionPresenceIcons sessionId={sessionId} />
        </>
      ) : isDraft ? (
        <>
          <PlusIcon className="size-3 shrink-0" />
          <span className={cn('font-mono tracking-tight', isActive && 'font-semibold')}>
            {denseLabel || '--'}
          </span>
        </>
      ) : (
        <div className="flex items-center gap-1 py-0.5">
          <div className="animate-pulse bg-black/10 dark:bg-white/10 h-3 w-8 rounded" />
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
        <div className="group relative flex items-center select-none" data-tab-id={sessionId}>
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
      <div className="group relative flex items-center select-none" data-tab-id={sessionId}>
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
 * Memoized ProjectTab — shallow-compares props. The parent passes `session`
 * as a stable reference from `sessionsMap`, so a tab only re-renders when
 * its own session row actually changes.
 */
const ProjectTab = memo(ProjectTabInner)
