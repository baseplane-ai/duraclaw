import { ChevronLeftIcon, ChevronRightIcon, CopyPlusIcon, PlusIcon, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import type { SessionRecord } from '~/db/sessions-collection'
import { StatusDot } from '~/features/agent-orch/session-utils'
import { useIsMobile } from '~/hooks/use-mobile'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useUserSettings } from '~/hooks/use-user-settings'
import { cn } from '~/lib/utils'

interface TabBarProps {
  /** The session currently being viewed — drives tab highlighting. Derived from URL. */
  activeSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onLastTabClosed?: () => void
  onNewSessionInTab?: (project: string) => void
  onNewTabForProject?: (project: string) => void
}

export function TabBar({
  activeSessionId,
  onSelectSession,
  onLastTabClosed,
  onNewSessionInTab,
  onNewTabForProject,
}: TabBarProps) {
  const { tabs, setActiveTab, removeTab } = useUserSettings()
  const { sessions } = useSessionsCollection()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabs.length intentionally triggers re-check
  useEffect(updateOverflow, [updateOverflow, tabs.length])

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
    const activeTab = tabs.find((t) => t.sessionId === activeSessionId)
    if (!activeTab) return
    const el = scrollRef.current.querySelector(`[data-tab-id="${activeTab.id}"]`) as HTMLElement
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeSessionId, tabs])

  const handleClose = useCallback(
    (tabId: string) => {
      const isLastTab = tabs.length === 1
      removeTab(tabId)
      if (isLastTab && onLastTabClosed) {
        onLastTabClosed()
      } else {
        const remaining = tabs.filter((t) => t.id !== tabId)
        if (remaining.length > 0) {
          const idx = tabs.findIndex((t) => t.id === tabId)
          const next = remaining[Math.min(idx, remaining.length - 1)]
          setActiveTab(next.id)
          onSelectSession(next.sessionId)
        }
      }
    },
    [tabs, removeTab, setActiveTab, onSelectSession, onLastTabClosed],
  )

  if (tabs.length === 0) return null

  return (
    <div className="relative" data-testid="tab-bar">
      <div
        ref={scrollRef}
        className="flex items-center border-b bg-background overflow-x-auto scrollbar-none"
        onWheel={handleWheel}
      >
        {tabs.map((tab) => {
          const currentSession = sessions.find((s) => s.id === tab.sessionId)

          return (
            <ProjectTab
              key={tab.id}
              tabId={tab.id}
              project={tab.project}
              title={tab.title}
              isActive={tab.sessionId === activeSessionId}
              currentSession={currentSession}
              onSelect={() => {
                setActiveTab(tab.id)
                onSelectSession(tab.sessionId)
              }}
              onClose={() => handleClose(tab.id)}
              onNewSessionInTab={
                onNewSessionInTab ? () => onNewSessionInTab(tab.project) : undefined
              }
              onNewTabForProject={
                onNewTabForProject ? () => onNewTabForProject(tab.project) : undefined
              }
            />
          )
        })}
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
  )
}

function ProjectTab({
  tabId,
  project,
  title,
  isActive,
  currentSession,
  onSelect,
  onClose,
  onNewSessionInTab,
  onNewTabForProject,
}: {
  tabId: string
  project: string
  title: string
  isActive: boolean
  currentSession: SessionRecord | undefined
  onSelect: () => void
  onClose: () => void
  onNewSessionInTab?: () => void
  onNewTabForProject?: () => void
}) {
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)

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
      >
        {currentSession && (
          <StatusDot
            status={currentSession.status || 'idle'}
            numTurns={currentSession.num_turns ?? 0}
          />
        )}
        <div className="flex flex-col items-start min-w-0">
          <span className="text-[11px] text-muted-foreground leading-tight font-normal">
            {project}
          </span>
          <span className="max-w-32 truncate leading-tight">{title}</span>
        </div>
      </button>
    </>
  )

  const handleMenuAction = useCallback((action: (() => void) | undefined) => {
    setMenuOpen(false)
    action?.()
  }, [])

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
                <span className="text-muted-foreground font-normal">{project} · </span>
                {title}
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
      </div>
      <DropdownMenuTrigger className="sr-only absolute size-0 overflow-hidden" />
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
