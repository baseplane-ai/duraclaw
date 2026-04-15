import { ChevronDown, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionRecord } from '~/db/sessions-collection'
import { getPreviewText, StatusDot } from '~/features/agent-orch/session-utils'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { cn } from '~/lib/utils'
import { useTabStore } from '~/stores/tabs'

interface TabBarProps {
  onSelectSession: (sessionId: string) => void
  onLastTabClosed?: () => void
}

function getSessionDisplayName(session: SessionRecord): string {
  return session.title || getPreviewText(session) || session.id.slice(0, 8)
}

export function TabBar({ onSelectSession, onLastTabClosed }: TabBarProps) {
  const { tabs, activeTabId, setActiveTab, removeTab } = useTabStore()
  const { sessions } = useSessionsCollection()

  if (tabs.length === 0) return null

  return (
    <div className="flex items-center border-b bg-background overflow-x-auto" data-testid="tab-bar">
      {tabs.map((tab) => (
        <ProjectTab
          key={tab.id}
          project={tab.project}
          sessionId={tab.sessionId}
          title={tab.title}
          isActive={activeTabId === tab.id}
          sessions={sessions}
          onSelect={() => {
            setActiveTab(tab.id)
            onSelectSession(tab.sessionId)
          }}
          onSwitchSession={(sessionId, title) => {
            useTabStore.getState().switchTabSession(tab.id, sessionId, title)
            setActiveTab(tab.id)
            onSelectSession(sessionId)
          }}
          onClose={() => {
            const isLastTab = tabs.length === 1
            removeTab(tab.id)
            if (isLastTab && onLastTabClosed) {
              onLastTabClosed()
            } else {
              const remaining = tabs.filter((t) => t.id !== tab.id)
              if (remaining.length > 0) {
                const idx = tabs.findIndex((t) => t.id === tab.id)
                const next = remaining[Math.min(idx, remaining.length - 1)]
                setActiveTab(next.id)
                onSelectSession(next.sessionId)
              }
            }
          }}
        />
      ))}
    </div>
  )
}

function ProjectTab({
  project,
  sessionId,
  title,
  isActive,
  sessions,
  onSelect,
  onSwitchSession,
  onClose,
}: {
  project: string
  sessionId: string
  title: string
  isActive: boolean
  sessions: SessionRecord[]
  onSelect: () => void
  onSwitchSession: (sessionId: string, title: string) => void
  onClose: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const caretRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })

  // Get all sessions for this project, sorted by activity
  const projectSessions = sessions
    .filter((s) => s.project === project && !s.archived)
    .sort((a, b) => {
      const aTime = new Date(a.last_activity ?? a.updated_at).getTime()
      const bTime = new Date(b.last_activity ?? b.updated_at).getTime()
      return bTime - aTime
    })

  const currentSession = sessions.find((s) => s.id === sessionId)
  const hasMultipleSessions = projectSessions.length > 1

  // Close menu on outside click/touch
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [menuOpen])

  const openMenu = useCallback(() => {
    if (caretRef.current) {
      const rect = caretRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 1, left: rect.left })
    }
    setMenuOpen(true)
  }, [])

  const toggleMenu = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false)
    } else {
      openMenu()
    }
  }, [menuOpen, openMenu])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: context menu handler for tab options
    <div
      className="group relative flex items-center border-r select-none"
      ref={containerRef}
      style={{ WebkitTouchCallout: 'none' }}
      onContextMenu={(e) => {
        e.preventDefault()
        toggleMenu()
      }}
    >
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent',
          isActive && 'bg-accent text-accent-foreground',
        )}
        onClick={onSelect}
      >
        {currentSession && (
          <StatusDot
            status={currentSession.status || 'idle'}
            numTurns={currentSession.num_turns ?? 0}
          />
        )}
        <div className="flex flex-col items-start min-w-0">
          <span className="text-[10px] text-muted-foreground leading-tight font-normal">
            {project}
          </span>
          <span className="max-w-32 truncate leading-tight">{title}</span>
        </div>
      </button>

      {/* Caret menu trigger — always visible so it's tappable on mobile */}
      <button
        ref={caretRef}
        type="button"
        className={cn(
          'px-1.5 self-stretch flex items-center transition-opacity hover:bg-muted',
          isActive || menuOpen ? 'opacity-60' : 'opacity-30 group-hover:opacity-60',
          menuOpen && 'opacity-100 bg-muted',
        )}
        onClick={(e) => {
          e.stopPropagation()
          toggleMenu()
        }}
        aria-label="Tab options"
      >
        <ChevronDown className="size-3" />
      </button>

      {/* Portaled tab menu — renders outside overflow:auto container */}
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 min-w-48 max-w-64 rounded-md border bg-popover p-1 shadow-md"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {/* Session switcher section */}
            {hasMultipleSessions && (
              <>
                <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Sessions
                </div>
                {projectSessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent',
                      s.id === sessionId && 'bg-accent/50',
                    )}
                    onClick={() => {
                      onSwitchSession(s.id, getSessionDisplayName(s))
                      setMenuOpen(false)
                    }}
                  >
                    <StatusDot status={s.status || 'idle'} numTurns={s.num_turns ?? 0} />
                    <span className="truncate">{getSessionDisplayName(s)}</span>
                    {s.id === sessionId && (
                      <span className="ml-auto text-[10px] text-muted-foreground">current</span>
                    )}
                  </button>
                ))}
                <div className="my-1 border-t" />
              </>
            )}

            {/* Close tab action */}
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent text-destructive"
              onClick={() => {
                setMenuOpen(false)
                onClose()
              }}
            >
              <X className="size-3" />
              <span>Close tab</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}
