import { X } from 'lucide-react'
import type { SessionRecord } from '~/db/sessions-collection'
import { StatusDot } from '~/features/agent-orch/session-utils'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { cn } from '~/lib/utils'
import { useTabStore } from '~/stores/tabs'

interface TabBarProps {
  onSelectSession: (sessionId: string) => void
  onLastTabClosed?: () => void
}

export function TabBar({ onSelectSession, onLastTabClosed }: TabBarProps) {
  const { tabs, activeTabId, setActiveTab, removeTab } = useTabStore()
  const { sessions } = useSessionsCollection()

  if (tabs.length === 0) return null

  return (
    <div className="flex items-center border-b bg-background overflow-x-auto" data-testid="tab-bar">
      {tabs.map((tab) => {
        const currentSession = sessions.find((s) => s.id === tab.sessionId)

        return (
          <ProjectTab
            key={tab.id}
            project={tab.project}
            title={tab.title}
            isActive={activeTabId === tab.id}
            currentSession={currentSession}
            onSelect={() => {
              setActiveTab(tab.id)
              onSelectSession(tab.sessionId)
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
        )
      })}
    </div>
  )
}

function ProjectTab({
  project,
  title,
  isActive,
  currentSession,
  onSelect,
  onClose,
}: {
  project: string
  title: string
  isActive: boolean
  currentSession: SessionRecord | undefined
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <div className="group relative flex items-center border-r select-none">
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

      {/* Close button */}
      <button
        type="button"
        className={cn(
          'px-1.5 self-stretch flex items-center transition-opacity hover:bg-muted',
          isActive ? 'opacity-60' : 'opacity-0 group-hover:opacity-60',
        )}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="Close tab"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
