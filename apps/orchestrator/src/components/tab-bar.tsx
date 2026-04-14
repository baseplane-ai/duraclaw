import { X } from 'lucide-react'
import { cn } from '~/lib/utils'
import { useTabStore } from '~/stores/tabs'

interface TabBarProps {
  onSelectSession: (sessionId: string) => void
  onLastTabClosed?: () => void
}

export function TabBar({ onSelectSession, onLastTabClosed }: TabBarProps) {
  const { tabs, activeTabId, setActiveTab, removeTab } = useTabStore()

  if (tabs.length === 0) return null

  return (
    <div className="flex items-center border-b bg-background overflow-x-auto" data-testid="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.sessionId}
          type="button"
          className={cn(
            'group flex items-center gap-1 border-r px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent',
            activeTabId === tab.sessionId && 'bg-accent text-accent-foreground',
          )}
          onClick={() => {
            setActiveTab(tab.sessionId)
            onSelectSession(tab.sessionId)
          }}
        >
          <span className="max-w-32 truncate">{tab.title}</span>
          <button
            type="button"
            className="ml-1 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              const isLastTab = tabs.length === 1
              removeTab(tab.sessionId)
              if (isLastTab && onLastTabClosed) {
                onLastTabClosed()
              } else {
                // Navigate to the new active tab
                const remaining = tabs.filter((t) => t.sessionId !== tab.sessionId)
                if (remaining.length > 0) {
                  const idx = tabs.findIndex((t) => t.sessionId === tab.sessionId)
                  const next = remaining[Math.min(idx, remaining.length - 1)]
                  setActiveTab(next.sessionId)
                  onSelectSession(next.sessionId)
                }
              }
            }}
            aria-label="Close tab"
          >
            <X className="size-3" />
          </button>
        </button>
      ))}
    </div>
  )
}
