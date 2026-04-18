/**
 * NavSessions — Session list in AppSidebar.
 *
 * Two sections:
 * 1. Recent — flat list of last ~5 sessions (any project), quick-access
 * 2. Worktrees — repo → worktree (with branch/dirty/PR) → sessions tree
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
import { userTabsCollection } from '~/db/user-tabs-collection'
import { getPreviewText, StatusDot } from '~/features/agent-orch/session-utils'
import { setActiveTabId } from '~/hooks/use-active-tab'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import type { PrInfo, ProjectInfo, UserTabRow } from '~/lib/types'
import { cn } from '~/lib/utils'

/** ProjectInfo extended with the `hidden` flag added by the API route */
interface ProjectInfoWithHidden extends ProjectInfo {
  hidden: boolean
}

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
        <DropdownMenuTrigger
          aria-label="Session actions"
          tabIndex={-1}
          className="sr-only absolute size-0 overflow-hidden"
        />
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

// ── PR badge ──────────────────────────────────────────────────────

function PrBadge({ pr }: { pr: PrInfo }) {
  const label =
    pr.state === 'MERGED'
      ? 'merged'
      : pr.state === 'CLOSED'
        ? 'closed'
        : pr.draft
          ? 'draft'
          : 'open'

  const color =
    pr.state === 'MERGED'
      ? 'text-purple-400'
      : pr.state === 'CLOSED'
        ? 'text-red-400'
        : pr.draft
          ? 'text-muted-foreground'
          : 'text-green-400'

  let checksIcon = ''
  if (pr.checks) {
    if (pr.checks.fail > 0) checksIcon = ' \u26A0'
    else if (pr.checks.pending > 0) checksIcon = ' \u22EF'
    else checksIcon = ' \u2713'
  }

  return (
    <span
      className={cn('text-[10px] whitespace-nowrap', color)}
      title={`PR #${pr.number} ${label}`}
    >
      #{pr.number}
      {checksIcon}
    </span>
  )
}

// ── Dirty / ahead indicators ──────────────────────────────────────

function WorktreeIndicators({ project }: { project: ProjectInfo }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px]">
      {project.dirty && (
        <span className="text-yellow-400" title="Uncommitted changes">
          {'●'}
        </span>
      )}
      {project.ahead > 0 && (
        <span className="text-muted-foreground" title={`${project.ahead} ahead`}>
          {project.ahead}
          {'▲'}
        </span>
      )}
      {project.pr && <PrBadge pr={project.pr} />}
    </span>
  )
}

// ── Extract org/repo from remote origin ──────────────────────────

function extractOrgRepo(repoOrigin: string | null): string {
  if (!repoOrigin) return 'Unknown'
  const cleaned = repoOrigin.replace(/\.git$/, '')
  // Handle ssh (git@github.com:org/repo) and https (https://github.com/org/repo)
  const match = cleaned.match(/[/:]([^/:]+\/[^/:]+)$/)
  return match ? match[1] : cleaned.split('/').pop() || 'Unknown'
}

// ── Main component ─────────────────────────────────────────────────

export function NavSessions() {
  const { sessions, updateSession, archiveSession } = useSessionsCollection()
  const { setOpenMobile } = useSidebar()
  const location = useLocation()
  const navigate = useNavigate()

  // Fetch projects from gateway
  const [projects, setProjects] = useState<ProjectInfoWithHidden[]>([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/gateway/projects/all')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (Array.isArray(data)) setProjects(data as ProjectInfoWithHidden[])
      })
      .catch(() => {})
      .finally(() => setProjectsLoaded(true))
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

  const visible = sessions.filter((s) => !s.archived)

  // Recent: last 5 sessions by last_activity
  const recent = [...visible].sort(byActivity).slice(0, 5)

  // Build session lookup by project name
  const sessionsByProject = new Map<string, SessionRecord[]>()
  for (const session of visible) {
    const key = session.project || 'unknown'
    if (!sessionsByProject.has(key)) sessionsByProject.set(key, [])
    sessionsByProject.get(key)?.push(session)
  }
  for (const [, projectSessions] of sessionsByProject) {
    projectSessions.sort(byActivity)
  }

  // Group projects by repo_origin
  const repoGroups = new Map<string, ProjectInfoWithHidden[]>()
  for (const project of projects) {
    const key = project.repo_origin || 'Unknown'
    if (!repoGroups.has(key)) repoGroups.set(key, [])
    repoGroups.get(key)?.push(project)
  }

  // Find sessions whose project doesn't match any known worktree (orphans)
  const knownProjectNames = new Set(projects.map((p) => p.name))
  const orphanGroups = new Map<string, SessionRecord[]>()
  for (const [projectName, projectSessions] of sessionsByProject) {
    if (!knownProjectNames.has(projectName)) {
      orphanGroups.set(projectName, projectSessions)
    }
  }

  const handleSelect = useCallback(
    (session: SessionRecord) => {
      // Insert-or-activate: reuse the existing tab for this session if one
      // exists; else open a fresh tab. Tab title/project come from the join
      // with agentSessionsCollection so we only need to seed the row shape.
      const tabs = userTabsCollection.toArray as unknown as UserTabRow[]
      const existing = tabs.find((t) => t.sessionId === session.id)
      if (existing) {
        setActiveTabId(existing.id)
      } else {
        const id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID().slice(0, 8)
            : Math.random().toString(36).slice(2, 10)
        const nextPos = tabs.length === 0 ? 0 : Math.max(0, ...tabs.map((t) => t.position)) + 1
        userTabsCollection.insert({
          id,
          userId: '',
          sessionId: session.id,
          position: nextPos,
          createdAt: new Date().toISOString(),
        } as UserTabRow & Record<string, unknown>)
        setActiveTabId(id)
      }
      setOpenMobile(false)
      navigate({ to: '/', search: { session: session.id } })
    },
    [setOpenMobile, navigate],
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

  // Determine active session from URL. The dashboard (`/`) owns session
  // selection via `?session=X`; legacy `/session/:id` redirects to the same.
  const searchParams = new URLSearchParams(location.searchStr)
  const activeSessionId = searchParams.get('session')

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
                    <span className="truncate text-[11px] text-muted-foreground leading-tight">
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

      {/* Unified worktree tree: repo → worktree (branch/dirty/PR) → sessions */}
      <SidebarGroup>
        <SidebarGroupLabel>
          <FolderGit2 className="mr-1 size-3" />
          Worktrees
        </SidebarGroupLabel>
        <SidebarMenu>
          {Array.from(repoGroups.entries()).map(([repoOrigin, repoProjects]) => (
            <RepoGroup
              key={repoOrigin}
              repoOrigin={repoOrigin}
              projects={repoProjects}
              sessionsByProject={sessionsByProject}
              activeSessionId={activeSessionId}
              onSelect={handleSelect}
              onRename={handleRename}
              onArchive={handleArchive}
              onToggleHidden={handleToggleHidden}
            />
          ))}

          {/* Orphan sessions (project not in any worktree) */}
          {Array.from(orphanGroups.entries()).map(([projectName, projectSessions]) => (
            <OrphanProjectGroup
              key={projectName}
              project={projectName}
              sessions={projectSessions}
              activeSessionId={activeSessionId}
              onSelect={handleSelect}
              onRename={handleRename}
              onArchive={handleArchive}
            />
          ))}

          {!projectsLoaded && (
            <SidebarMenuItem>
              <SidebarMenuButton disabled>
                <span className="text-muted-foreground">Loading...</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroup>
    </>
  )
}

// ── Repo group (L0) ──────────────────────────────────────────────

function RepoGroup({
  repoOrigin,
  projects,
  sessionsByProject,
  activeSessionId,
  onSelect,
  onRename,
  onArchive,
  onToggleHidden,
}: {
  repoOrigin: string
  projects: ProjectInfoWithHidden[]
  sessionsByProject: Map<string, SessionRecord[]>
  activeSessionId: string | null
  onSelect: (session: SessionRecord) => void
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string, archived: boolean) => void
  onToggleHidden: (projectName: string) => void
}) {
  const orgRepo = extractOrgRepo(repoOrigin)
  // Check if any worktree in this repo has the active session
  const hasActive = projects.some((p) => {
    const sessions = sessionsByProject.get(p.name)
    return sessions?.some((s) => s.id === activeSessionId)
  })

  return (
    <Collapsible asChild defaultOpen={hasActive || true} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={orgRepo}>
            <FolderGit2 className="size-4" />
            <span className="truncate">{orgRepo}</span>
            <span className="ml-auto text-xs text-muted-foreground">{projects.length}</span>
            <ChevronRight className="ml-1 size-3 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {projects.map((project) => (
              <WorktreeNode
                key={project.name}
                project={project}
                sessions={sessionsByProject.get(project.name) ?? []}
                activeSessionId={activeSessionId}
                onSelect={onSelect}
                onRename={onRename}
                onArchive={onArchive}
                onToggleHidden={onToggleHidden}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

// ── Worktree node (L1) ───────────────────────────────────────────

function WorktreeNode({
  project,
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onArchive,
  onToggleHidden,
}: {
  project: ProjectInfoWithHidden
  sessions: SessionRecord[]
  activeSessionId: string | null
  onSelect: (session: SessionRecord) => void
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string, archived: boolean) => void
  onToggleHidden: (projectName: string) => void
}) {
  const hasActive = sessions.some((s) => s.id === activeSessionId)
  const hasSessions = sessions.length > 0
  const isHidden = project.hidden === true
  const [maxVisible, setMaxVisible] = useState(5)
  const displayed = sessions.slice(0, maxVisible)
  const hasMore = sessions.length > maxVisible

  if (!hasSessions) {
    // Worktree with no sessions — show as a leaf with branch info
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton className={cn('group/wt', isHidden && 'opacity-40')}>
          <GitBranchIcon className="size-3 shrink-0 mt-0.5" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm leading-tight">{project.name}</span>
            <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground leading-tight">
              {project.branch}
              <WorktreeIndicators project={project} />
            </span>
          </div>
          <button
            type="button"
            className="ml-1 shrink-0 p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover/wt:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onToggleHidden(project.name)
            }}
          >
            {isHidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          </button>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    )
  }

  // Worktree with sessions — collapsible
  return (
    <Collapsible asChild defaultOpen={hasActive || sessions.length <= 3} className="group/wt-col">
      <SidebarMenuSubItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton className={cn(isHidden && 'opacity-40')}>
            <GitBranchIcon className="size-3 shrink-0 mt-0.5" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm leading-tight">{project.name}</span>
              <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground leading-tight">
                {project.branch}
                <WorktreeIndicators project={project} />
              </span>
            </div>
            <span className="shrink-0 text-[10px] text-muted-foreground">{sessions.length}</span>
            <ChevronRight className="ml-0.5 size-2.5 shrink-0 transition-transform duration-200 group-data-[state=open]/wt-col:rotate-90" />
          </SidebarMenuSubButton>
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
      </SidebarMenuSubItem>
    </Collapsible>
  )
}

// ── Orphan project group (sessions with no worktree match) ────────

function OrphanProjectGroup({
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
            <FolderGit2 className="size-4 text-muted-foreground" />
            <span className="truncate">{project}</span>
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
