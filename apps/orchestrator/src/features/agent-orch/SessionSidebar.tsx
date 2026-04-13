/**
 * SessionSidebar — Left sidebar showing session list grouped by project.
 */

import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { ScrollArea } from '~/components/ui/scroll-area'
import type { SessionRecord } from '~/db/sessions-collection'
import { cn } from '~/lib/utils'
import { useWorkspaceStore } from '~/stores/workspace'
import { ActiveStrip } from './ActiveStrip'
import { type DateRange, FilterChipBar, getRecentAndOlder } from './FilterChipBar'
import { SessionListItem } from './SessionListItem'
import { SpawnAgentForm, type SpawnFormConfig } from './SpawnAgentForm'

export function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 7)
  const monthAgo = new Date(today)
  monthAgo.setMonth(monthAgo.getMonth() - 1)

  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  if (date >= weekAgo) return 'This Week'
  if (date >= monthAgo) return 'This Month'
  return 'Older'
}

export const DATE_GROUP_ORDER = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older']

interface SessionSidebarProps {
  sessions: SessionRecord[]
  selectedSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onSpawn: (config: SpawnFormConfig) => void
  onArchiveSession?: (sessionId: string, archived: boolean) => void
  onRenameSession?: (sessionId: string, title: string) => void
  onTagSession?: (sessionId: string, tag: string | null) => void
  onForkSession?: (sessionId: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export function SessionSidebar({
  sessions,
  selectedSessionId,
  onSelectSession,
  onSpawn,
  onArchiveSession,
  onRenameSession,
  onTagSession,
  onForkSession,
  collapsed,
  onToggleCollapse,
}: SessionSidebarProps) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showArchived, setShowArchived] = useState(false)
  const [groupBy, setGroupBy] = useState<'project' | 'date'>('project')
  const [dateRange, setDateRange] = useState<DateRange>('this-week')
  const [showOlder, setShowOlder] = useState(false)
  const workspaceProjects = useWorkspaceStore((s) => s.workspaceProjects)

  const filteredSessions = sessions.filter((s) => {
    if (workspaceProjects && !workspaceProjects.includes(s.project)) return false
    if (!showArchived && s.archived) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      if (
        !s.id.toLowerCase().includes(q) &&
        !(s.prompt ?? '').toLowerCase().includes(q) &&
        !(s.title ?? '').toLowerCase().includes(q) &&
        !(s.tag ?? '').toLowerCase().includes(q)
      )
        return false
    }
    if (statusFilter === 'running') return s.status === 'running'
    if (statusFilter === 'completed') return s.status === 'idle'
    if (statusFilter === 'failed') return s.status === 'failed' || s.status === 'aborted'
    return true
  })

  const { recent: recentSessions, older: olderSessions } = getRecentAndOlder(
    filteredSessions,
    dateRange,
  )

  const groups = new Map<string, SessionRecord[]>()
  for (const session of recentSessions) {
    const key = groupBy === 'date' ? getDateGroup(session.created_at) : session.project || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)?.push(session)
  }

  const sortedGroupKeys =
    groupBy === 'date'
      ? DATE_GROUP_ORDER.filter((k) => groups.has(k))
      : Array.from(groups.keys()).sort()

  const toggleGroup = (project: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })
  }

  return (
    <div
      className={cn('flex h-full shrink-0 flex-col border-r', collapsed ? 'w-12' : 'w-[280px]')}
      data-testid="session-sidebar"
    >
      <div className="flex items-center justify-between border-b p-3">
        {!collapsed && <h3 className="text-sm font-semibold">Sessions</h3>}
        <div className="flex items-center gap-1">
          {!collapsed && (
            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)}>
              <PlusIcon className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            data-testid="sidebar-collapse-toggle"
            className="size-6 p-0"
          >
            {collapsed ? (
              <ChevronRightIcon className="size-4" />
            ) : (
              <ChevronLeftIcon className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {collapsed ? (
        <div className="space-y-1 p-1">
          {filteredSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session.id)}
              title={session.id}
              className={cn(
                'flex w-full items-center justify-center rounded p-2 hover:bg-accent',
                selectedSessionId === session.id && 'bg-accent',
              )}
            >
              <span
                className={cn(
                  'size-2 rounded-full',
                  session.status === 'running'
                    ? 'bg-green-500'
                    : session.status === 'failed' || session.status === 'aborted'
                      ? 'bg-red-500'
                      : 'bg-gray-400',
                )}
              />
            </button>
          ))}
        </div>
      ) : (
        <>
          {showAdvanced && (
            <div className="border-b p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Advanced</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1 text-xs"
                  onClick={() => setShowAdvanced(false)}
                >
                  Close
                </Button>
              </div>
              <SpawnAgentForm
                onSpawn={(config) => {
                  onSpawn(config)
                  setShowAdvanced(false)
                }}
                inline
              />
            </div>
          )}

          <ActiveStrip
            sessions={sessions}
            onSelectSession={onSelectSession}
            selectedSessionId={selectedSessionId}
          />

          <div className="space-y-2 border-b p-3">
            <Input
              placeholder="Search sessions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search sessions"
              data-testid="session-search"
            />
            <FilterChipBar
              statusFilter={statusFilter}
              onStatusChange={setStatusFilter}
              dateRange={dateRange}
              onDateRangeChange={setDateRange}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                aria-label="Show archived sessions"
                data-testid="show-archived-toggle"
              />
              Show archived
            </label>
            <div className="flex gap-1">
              <Button
                variant={groupBy === 'project' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 text-xs"
                onClick={() => setGroupBy('project')}
              >
                <FolderIcon className="mr-1 size-3" />
                Project
              </Button>
              <Button
                variant={groupBy === 'date' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 text-xs"
                onClick={() => setGroupBy('date')}
              >
                <CalendarIcon className="mr-1 size-3" />
                Date
              </Button>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="space-y-1 p-2">
              {recentSessions.length === 0 && olderSessions.length === 0 && (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  {sessions.length === 0
                    ? 'No sessions yet — click New to get started'
                    : 'No sessions match your search'}
                </p>
              )}
              {sortedGroupKeys.map((key) => {
                const groupSessions = groups.get(key) ?? []
                return (
                  <div key={key} data-testid="session-tree">
                    <button
                      type="button"
                      onClick={() => toggleGroup(key)}
                      className="flex w-full items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent"
                    >
                      {collapsedGroups.has(key) ? (
                        <>
                          <ChevronRightIcon className="size-3" />
                          <FolderIcon className="size-3" />
                        </>
                      ) : (
                        <>
                          <ChevronDownIcon className="size-3" />
                          <FolderOpenIcon className="size-3" />
                        </>
                      )}
                      {key}
                      <span className="ml-auto">{groupSessions.length}</span>
                    </button>
                    {!collapsedGroups.has(key) && (
                      <div className="ml-2 space-y-1">
                        {groupSessions.map((session) => (
                          <SessionListItem
                            key={session.id}
                            session={session}
                            isSelected={selectedSessionId === session.id}
                            onClick={() => onSelectSession(session.id)}
                            onArchive={(archived) => onArchiveSession?.(session.id, archived)}
                            onRename={(title) => onRenameSession?.(session.id, title)}
                            onTag={(tag) => onTagSession?.(session.id, tag)}
                            onFork={() => onForkSession?.(session.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {olderSessions.length > 0 && (
              <div className="border-t p-2">
                <button
                  type="button"
                  onClick={() => setShowOlder(!showOlder)}
                  className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
                >
                  {showOlder ? (
                    <ChevronDownIcon className="size-3" />
                  ) : (
                    <ChevronRightIcon className="size-3" />
                  )}
                  Older Sessions ({olderSessions.length})
                </button>
                {showOlder && (
                  <div className="ml-2 mt-1 space-y-1">
                    {olderSessions.map((session) => (
                      <SessionListItem
                        key={session.id}
                        session={session}
                        isSelected={selectedSessionId === session.id}
                        onClick={() => onSelectSession(session.id)}
                        onArchive={(archived) => onArchiveSession?.(session.id, archived)}
                        onRename={(title) => onRenameSession?.(session.id, title)}
                        onTag={(tag) => onTagSession?.(session.id, tag)}
                        onFork={() => onForkSession?.(session.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </>
      )}
    </div>
  )
}
