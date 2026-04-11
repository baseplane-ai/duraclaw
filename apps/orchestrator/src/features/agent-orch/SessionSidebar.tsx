/**
 * SessionSidebar — Left sidebar showing session list grouped by project.
 */

import {
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { cn } from '~/lib/utils'
import { SessionListItem } from './SessionListItem'
import { SpawnAgentForm, type SpawnFormConfig } from './SpawnAgentForm'
import type { SessionRecord } from './use-agent-orch-sessions'

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
  const [showSpawnForm, setShowSpawnForm] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showArchived, setShowArchived] = useState(false)

  const filteredSessions = sessions.filter((s) => {
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
    if (statusFilter === 'completed') return s.status === 'completed' || s.status === 'idle'
    if (statusFilter === 'failed') return s.status === 'failed' || s.status === 'aborted'
    return true
  })

  const groups = new Map<string, SessionRecord[]>()
  for (const session of filteredSessions) {
    const project = session.project || 'unknown'
    if (!groups.has(project)) groups.set(project, [])
    groups.get(project)?.push(session)
  }

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
            <Button variant="ghost" size="sm" onClick={() => setShowSpawnForm(!showSpawnForm)}>
              <PlusIcon className="mr-1 size-4" />
              New
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
          {showSpawnForm && (
            <div className="border-b p-3">
              <SpawnAgentForm
                onSpawn={(config) => {
                  onSpawn(config)
                  setShowSpawnForm(false)
                }}
                inline
              />
            </div>
          )}

          <div className="space-y-2 border-b p-3">
            <Input
              placeholder="Search sessions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search sessions"
              data-testid="session-search"
            />
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? 'all')}>
              <SelectTrigger aria-label="Filter by status" data-testid="session-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
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
          </div>

          <ScrollArea className="flex-1">
            <div className="space-y-1 p-2">
              {filteredSessions.length === 0 && (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  {sessions.length === 0
                    ? 'No sessions yet — click New to get started'
                    : 'No sessions match your search'}
                </p>
              )}
              {Array.from(groups.entries()).map(([project, groupSessions]) => (
                <div key={project} data-testid="session-tree">
                  <button
                    type="button"
                    onClick={() => toggleGroup(project)}
                    className="flex w-full items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent"
                  >
                    {collapsedGroups.has(project) ? (
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
                    {project}
                    <span className="ml-auto">{groupSessions.length}</span>
                  </button>
                  {!collapsedGroups.has(project) && (
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
              ))}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  )
}
