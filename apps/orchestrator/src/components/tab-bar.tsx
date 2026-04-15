import { ChevronDown, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
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
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

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

  const handleBlur = useCallback((e: React.FocusEvent) => {
    // Close dropdown if focus leaves the dropdown area
    if (dropdownRef.current && !dropdownRef.current.contains(e.relatedTarget as Node)) {
      setDropdownOpen(false)
    }
  }, [])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: blur handler for dropdown dismiss
    <div
      className="group relative flex items-center border-r"
      ref={dropdownRef}
      onBlur={handleBlur}
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

      {/* Session switcher dropdown trigger */}
      {hasMultipleSessions && (
        <button
          type="button"
          className={cn(
            'px-1 py-1.5 opacity-0 hover:bg-muted transition-opacity',
            isActive ? 'opacity-60' : 'group-hover:opacity-60',
            dropdownOpen && 'opacity-100 bg-muted',
          )}
          onClick={(e) => {
            e.stopPropagation()
            setDropdownOpen((v) => !v)
          }}
          aria-label="Switch session"
        >
          <ChevronDown className="size-3" />
        </button>
      )}

      {/* Close button */}
      <button
        type="button"
        className="px-1 py-1.5 opacity-0 hover:bg-muted group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="Close tab"
      >
        <X className="size-3" />
      </button>

      {/* Session dropdown */}
      {dropdownOpen && hasMultipleSessions && (
        <div className="absolute left-0 top-full z-50 mt-px min-w-48 max-w-64 rounded-md border bg-popover p-1 shadow-md">
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
                setDropdownOpen(false)
              }}
            >
              <StatusDot status={s.status || 'idle'} numTurns={s.num_turns ?? 0} />
              <span className="truncate">{getSessionDisplayName(s)}</span>
              {s.id === sessionId && (
                <span className="ml-auto text-[10px] text-muted-foreground">current</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
