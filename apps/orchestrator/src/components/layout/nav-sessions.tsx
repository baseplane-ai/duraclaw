/**
 * NavSessions — Session list in AppSidebar.
 *
 * Two sections:
 * 1. Recent — flat list of last ~5 sessions (any project), with project subtitle
 * 2. Projects — collapsible folders grouping all non-archived sessions
 *
 * Long-press / right-click on any session item opens rename/archive context menu.
 */

import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  ArchiveIcon,
  ChevronRight,
  ClockIcon,
  EditIcon,
  Eye,
  EyeOff,
  FolderGit2,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '~/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '~/components/ui/sidebar'
import type { SessionRecord } from '~/db/sessions-collection'
import { getPreviewText, StatusDot } from '~/features/agent-orch/session-utils'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { useTabStore } from '~/stores/tabs'

function getDisplayName(session: SessionRecord): string {
  return session.title || getPreviewText(session) || session.id.slice(0, 8)
}

// ── Context menu for session items ─────────────────────────────────

function SessionContextMenu({
  session,
  children,
  onRename,
  onArchive,
}: {
  session: SessionRecord
  children: React.ReactNode
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string, archived: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setOpen(true)
  }, [])

  const handleTouchStart = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null
      setOpen(true)
    }, 500)
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleRename = useCallback(() => {
    const newTitle = prompt('Rename session', getDisplayName(session))
    if (newTitle?.trim()) {
      onRename(session.id, newTitle.trim())
    }
  }, [session, onRename])

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu on right-click/long-press only */}
      <span
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchEnd}
      >
        {children}
      </span>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger className="sr-only absolute size-0 overflow-hidden" />
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onClick={handleRename}>
            <EditIcon className="mr-2 size-3" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onArchive(session.id, !session.archived)}>
            <ArchiveIcon className="mr-2 size-3" />
            {session.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/** Sort by last_activity DESC, NULLs last (fall back to updated_at within NULL group) */
function byActivity(a: SessionRecord, b: SessionRecord): number {
  const aHas = !!a.last_activity
  const bHas = !!b.last_activity
  if (aHas !== bHas) return aHas ? -1 : 1
  const aTime = new Date(a.last_activity ?? a.updated_at).getTime()
  const bTime = new Date(b.last_activity ?? b.updated_at).getTime()
  return bTime - aTime
}

// ── Main component ─────────────────────────────────────────────────

export function NavSessions() {
  const { sessions, updateSession, archiveSession } = useSessionsCollection()
  const { setOpenMobile } = useSidebar()
  const location = useLocation()
  const navigate = useNavigate()
  const addTab = useTabStore((s) => s.addTab)

  const visible = sessions.filter((s) => !s.archived)

  // Recent: last 5 sessions by last_activity (gateway-sourced timestamp)
  const recent = [...visible].sort(byActivity).slice(0, 5)

  // Projects: group all visible sessions, sorted by last_activity DESC within each group
  const groups = new Map<string, SessionRecord[]>()
  for (const session of visible) {
    const key = session.project || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)?.push(session)
  }
  for (const [, projectSessions] of groups) {
    projectSessions.sort(byActivity)
  }

  const handleSelect = useCallback(
    (session: SessionRecord) => {
      addTab(session.project || 'unknown', session.id, getDisplayName(session))
      setOpenMobile(false)
      navigate({ to: '/session/$id', params: { id: session.id } })
    },
    [addTab, setOpenMobile, navigate],
  )

  const handleRename = useCallback(
    (sessionId: string, title: string) => {
      updateSession(sessionId, { title })
    },
    [updateSession],
  )

  const handleArchive = useCallback(
    (sessionId: string, archived: boolean) => {
      archiveSession(sessionId, archived)
    },
    [archiveSession],
  )

  // Determine active session from URL
  const searchParams = new URLSearchParams(location.searchStr)
  const activeSessionId = location.pathname.startsWith('/session/')
    ? location.pathname.split('/session/')[1]
    : searchParams.get('session')

  return (
    <>
      {/* Recent sessions */}
      <SidebarGroup>
        <SidebarGroupLabel>
          <ClockIcon className="mr-1 size-3" />
          Recent
        </SidebarGroupLabel>
        <SidebarGroupAction asChild>
          <Link to="/" aria-label="New session" onClick={() => setOpenMobile(false)}>
            <PlusIcon className="size-4" />
          </Link>
        </SidebarGroupAction>
        <SidebarMenu>
          {recent.map((session) => (
            <SidebarMenuItem key={session.id}>
              <SessionContextMenu
                session={session}
                onRename={handleRename}
                onArchive={handleArchive}
              >
                <SidebarMenuButton
                  isActive={activeSessionId === session.id}
                  tooltip={`${getDisplayName(session)} — ${session.project}`}
                  onClick={() => handleSelect(session)}
                >
                  <StatusDot status={session.status || 'idle'} numTurns={session.num_turns ?? 0} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm leading-tight">
                      {getDisplayName(session)}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground leading-tight">
                      {session.project}
                    </span>
                  </div>
                </SidebarMenuButton>
              </SessionContextMenu>
            </SidebarMenuItem>
          ))}
          {visible.length === 0 && (
            <SidebarMenuItem>
              <SidebarMenuButton disabled>
                <span className="text-muted-foreground">No sessions yet</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroup>

      {/* Project browser */}
      <SidebarGroup>
        <SidebarGroupLabel>
          <FolderIcon className="mr-1 size-3" />
          Projects
        </SidebarGroupLabel>
        <SidebarMenu>
          {Array.from(groups.entries())
            .sort(([, a], [, b]) => {
              const aMax = a[0]?.last_activity ?? a[0]?.updated_at ?? ''
              const bMax = b[0]?.last_activity ?? b[0]?.updated_at ?? ''
              return bMax > aMax ? 1 : bMax < aMax ? -1 : 0
            })
            .map(([project, projectSessions]) => (
              <ProjectGroup
                key={project}
                project={project}
                sessions={projectSessions}
                activeSessionId={activeSessionId}
                onSelect={handleSelect}
                onRename={handleRename}
                onArchive={handleArchive}
              />
            ))}
        </SidebarMenu>
      </SidebarGroup>

      <AllProjectsBrowser />
    </>
  )
}

// ── Project collapsible group ──────────────────────────────────────

function ProjectGroup({
  project,
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onArchive,
}: {
  project: string
  sessions: SessionRecord[]
  activeSessionId: string | null
  onSelect: (session: SessionRecord) => void
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string, archived: boolean) => void
}) {
  const hasActive = sessions.some((s) => s.id === activeSessionId)
  const [maxVisible, setMaxVisible] = useState(5)
  const displayed = sessions.slice(0, maxVisible)
  const hasMore = sessions.length > maxVisible

  return (
    <Collapsible
      asChild
      defaultOpen={hasActive || sessions.length <= 5}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={project}>
            <FolderIcon className="size-4" />
            <span>{project}</span>
            <span className="ml-auto text-xs text-muted-foreground">{sessions.length}</span>
            <ChevronRight className="ml-1 size-3 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {displayed.map((session) => (
              <SidebarMenuSubItem key={session.id}>
                <SessionContextMenu session={session} onRename={onRename} onArchive={onArchive}>
                  <SidebarMenuSubButton
                    isActive={activeSessionId === session.id}
                    onClick={() => onSelect(session)}
                  >
                    <StatusDot
                      status={session.status || 'idle'}
                      numTurns={session.num_turns ?? 0}
                    />
                    <span className="truncate">{getDisplayName(session)}</span>
                  </SidebarMenuSubButton>
                </SessionContextMenu>
              </SidebarMenuSubItem>
            ))}
            {hasMore && (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton onClick={() => setMaxVisible((v) => v + 10)}>
                  <span className="text-muted-foreground">
                    {sessions.length - maxVisible} more...
                  </span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

// ── All Projects browser ──────────────────────────────────────────

interface ProjectInfo {
  name: string
  path: string
  branch: string
  dirty: boolean
  active_session: string | null
  repo_origin: string
  hidden: boolean
}

function extractRepoName(repoOrigin: string): string {
  const cleaned = repoOrigin.replace(/\.git$/, '')
  const parts = cleaned.split(/[/:]/)
  const name = parts[parts.length - 1] || 'Unknown'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function AllProjectsBrowser() {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/gateway/projects/all')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (Array.isArray(data)) setProjects(data as ProjectInfo[])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleToggleHidden = useCallback((projectName: string) => {
    setProjects((prev) => {
      const updated = prev.map((p) => (p.name === projectName ? { ...p, hidden: !p.hidden } : p))
      const hiddenList = updated.filter((p) => p.hidden).map((p) => p.name)
      fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'hidden_projects', value: JSON.stringify(hiddenList) }),
      }).catch(() => {})
      return updated
    })
  }, [])

  // Group by repo_origin
  const repoGroups = new Map<string, ProjectInfo[]>()
  for (const project of projects) {
    const key = project.repo_origin || 'Unknown'
    if (!repoGroups.has(key)) repoGroups.set(key, [])
    repoGroups.get(key)?.push(project)
  }

  if (loading) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>
          <FolderGit2 className="mr-1 size-3" />
          All Projects
        </SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <span className="text-muted-foreground">Loading...</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    )
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        <FolderGit2 className="mr-1 size-3" />
        All Projects
      </SidebarGroupLabel>
      <SidebarMenu>
        {Array.from(repoGroups.entries()).map(([repoOrigin, repoProjects]) => (
          <Collapsible key={repoOrigin} asChild defaultOpen className="group/collapsible">
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton tooltip={extractRepoName(repoOrigin)}>
                  <FolderGit2 className="size-4" />
                  <span>{extractRepoName(repoOrigin)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {repoProjects.length}
                  </span>
                  <ChevronRight className="ml-1 size-3 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  {repoProjects.map((project) => (
                    <SidebarMenuSubItem key={project.name}>
                      <SidebarMenuSubButton className={project.hidden ? 'opacity-40' : undefined}>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm leading-tight">{project.name}</span>
                          <span className="flex items-center gap-1 truncate text-[10px] text-muted-foreground leading-tight">
                            <GitBranchIcon className="size-2.5" />
                            {project.branch}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="ml-auto shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleToggleHidden(project.name)
                          }}
                        >
                          {project.hidden ? (
                            <EyeOff className="size-3" />
                          ) : (
                            <Eye className="size-3" />
                          )}
                        </button>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
