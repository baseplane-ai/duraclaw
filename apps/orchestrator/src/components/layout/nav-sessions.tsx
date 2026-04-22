/**
 * NavSessions — Session list in AppSidebar.
 *
 * Two sections:
 * 1. Recent — flat list of last ~5 sessions (any project), quick-access
 * 2. Worktrees — repo → worktree (with branch/dirty/PR) → sessions tree
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useLocation, useNavigate } from '@tanstack/react-router'
import {
  ArchiveIcon,
  ChevronRight,
  ClockIcon,
  EditIcon,
  Eye,
  EyeOff,
  FolderGit2,
  GitBranchIcon,
  Layers,
  PlusIcon,
} from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '~/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '~/components/ui/sidebar'
import { projectsCollection } from '~/db/projects-collection'
import type { SessionRecord } from '~/db/session-record'
import { userPreferencesCollection } from '~/db/user-preferences-collection'
import { getPreviewText, StatusDot } from '~/features/agent-orch/session-utils'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { newDraftTabId, useTabSync } from '~/hooks/use-tab-sync'
import { apiUrl } from '~/lib/platform'
import type { PrInfo, ProjectInfo } from '~/lib/types'
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

/** Sort by lastActivity DESC, NULLs last (fall back to updated_at within NULL group) */
function byActivity(a: SessionRecord, b: SessionRecord): number {
  const aHas = !!a.lastActivity
  const bHas = !!b.lastActivity
  if (aHas !== bHas) return aHas ? -1 : 1
  const aTime = new Date(a.lastActivity ?? a.updatedAt).getTime()
  const bTime = new Date(b.lastActivity ?? b.updatedAt).getTime()
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
  const { openTab } = useTabSync()

  // Synced collections: projects + user preferences (GH#32 phase p4).
  // Replaces the old direct GET /api/gateway/projects/all client fetch —
  // the projects collection is now driven by UserSettingsDO delta frames
  // and D1-authoritative /api/projects cold-start queryFn.
  const { data: projectRows } = useLiveQuery(projectsCollection as any)
  const { data: prefsRows } = useLiveQuery(userPreferencesCollection as any)

  const hiddenSet = useMemo(() => {
    const raw = (prefsRows as Array<{ hiddenProjects?: string | null }> | undefined)?.[0]
      ?.hiddenProjects
    if (!raw) return new Set<string>()
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed)
        ? new Set(parsed.filter((v): v is string => typeof v === 'string'))
        : new Set<string>()
    } catch {
      return new Set<string>()
    }
  }, [prefsRows])

  const projects = useMemo<ProjectInfoWithHidden[]>(() => {
    const list = (projectRows ?? []) as ProjectInfo[]
    return list.map((p) => ({ ...p, hidden: hiddenSet.has(p.name) }))
  }, [projectRows, hiddenSet])

  const projectsLoaded = projectRows !== undefined

  const handleToggleHidden = useCallback(
    (projectName: string) => {
      const nextHidden = new Set(hiddenSet)
      if (nextHidden.has(projectName)) nextHidden.delete(projectName)
      else nextHidden.add(projectName)
      const hiddenList = [...nextHidden]
      fetch(apiUrl('/api/user/preferences'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'hidden_projects', value: JSON.stringify(hiddenList) }),
      }).catch(() => {})
    },
    [hiddenSet],
  )

  const visible = sessions.filter((s) => !s.archived)

  // Recent: last 5 sessions by lastActivity
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
      // Navigation to /?session=X triggers AgentOrchPage's deep-link effect,
      // which calls openTab() on the Yjs Y.Array. No direct tab manipulation needed.
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

  const handleOpenChain = useCallback(
    (issueNumber: number) => {
      openTab(`chain:${issueNumber}`, { kind: 'chain', issueNumber })
      setOpenMobile(false)
      // Route params typing requires the generated route tree to include
      // the chain route; cast to the router's expected shape.
      navigate({
        to: '/chain/$issueNumber',
        params: { issueNumber: String(issueNumber) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    },
    [openTab, navigate, setOpenMobile],
  )

  // Determine active session from URL. The dashboard (`/`) owns session
  // selection via `?session=X`; legacy `/session/:id` redirects to the same.
  const searchParams = new URLSearchParams(location.searchStr)
  const activeSessionId = searchParams.get('session')

  const handleNewSession = useCallback(() => {
    // Open a fresh draft tab (no preselected project). AgentOrchPage's
    // render branches off activeSessionId; if it matches an existing
    // (real or draft) tab, the page keeps showing that session. Creating
    // a new draft forces the page onto the QuickPromptInput picker via
    // the "draft id with no project meta" fall-through.
    const draftId = newDraftTabId()
    openTab(draftId)
    setOpenMobile(false)
    navigate({ to: '/', search: { session: draftId } })
  }, [openTab, setOpenMobile, navigate])

  return (
    <>
      {/* New session — prominent top-level action */}
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleNewSession}
              tooltip="New session"
              aria-label="New session"
            >
              <PlusIcon className="size-4" />
              <span>New session</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      {/* Recent sessions */}
      <SidebarGroup>
        <SidebarGroupLabel>
          <ClockIcon className="mr-1 size-3" />
          Recent
        </SidebarGroupLabel>
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
                  <StatusDot status={session.status || 'idle'} numTurns={session.numTurns ?? 0} />
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
              onOpenChain={handleOpenChain}
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
  onOpenChain,
}: {
  repoOrigin: string
  projects: ProjectInfoWithHidden[]
  sessionsByProject: Map<string, SessionRecord[]>
  activeSessionId: string | null
  onSelect: (session: SessionRecord) => void
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string, archived: boolean) => void
  onToggleHidden: (projectName: string) => void
  onOpenChain: (issueNumber: number) => void
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
                onOpenChain={onOpenChain}
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
  onOpenChain,
}: {
  project: ProjectInfoWithHidden
  sessions: SessionRecord[]
  activeSessionId: string | null
  onSelect: (session: SessionRecord) => void
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string, archived: boolean) => void
  onToggleHidden: (projectName: string) => void
  onOpenChain: (issueNumber: number) => void
}) {
  const hasActive = sessions.some((s) => s.id === activeSessionId)
  const hasSessions = sessions.length > 0
  const isHidden = project.hidden === true
  const [maxVisible, setMaxVisible] = useState(5)

  // Partition sessions into kataIssue chain groups and orphan rows.
  const chainGroups = new Map<number, SessionRecord[]>()
  const orphanSessions: SessionRecord[] = []
  for (const s of sessions) {
    if (typeof s.kataIssue === 'number') {
      const arr = chainGroups.get(s.kataIssue)
      if (arr) arr.push(s)
      else chainGroups.set(s.kataIssue, [s])
    } else {
      orphanSessions.push(s)
    }
  }
  // Sort chain entries by freshest-member activity (desc).
  const chainEntries = Array.from(chainGroups.entries()).sort(([, a], [, b]) => {
    const aFirst = a[0]
    const bFirst = b[0]
    const aTime = aFirst ? new Date(aFirst.lastActivity ?? aFirst.updatedAt).getTime() : 0
    const bTime = bFirst ? new Date(bFirst.lastActivity ?? bFirst.updatedAt).getTime() : 0
    return bTime - aTime
  })
  const displayedOrphans = orphanSessions.slice(0, maxVisible)
  const hasMore = orphanSessions.length > maxVisible

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
            {chainEntries.map(([issueNumber, chainSessions]) => (
              <ChainNode
                key={`chain-${issueNumber}`}
                issueNumber={issueNumber}
                sessions={chainSessions}
                activeSessionId={activeSessionId}
                onSelect={onSelect}
                onRename={onRename}
                onArchive={onArchive}
                onOpenChain={onOpenChain}
              />
            ))}
            {displayedOrphans.map((session) => (
              <SidebarMenuSubItem key={session.id}>
                <SessionContextMenu session={session} onRename={onRename} onArchive={onArchive}>
                  <SidebarMenuSubButton
                    isActive={activeSessionId === session.id}
                    onClick={() => onSelect(session)}
                  >
                    <StatusDot status={session.status || 'idle'} numTurns={session.numTurns ?? 0} />
                    <span className="truncate">{getDisplayName(session)}</span>
                  </SidebarMenuSubButton>
                </SessionContextMenu>
              </SidebarMenuSubItem>
            ))}
            {hasMore && (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton onClick={() => setMaxVisible((v) => v + 10)}>
                  <span className="text-muted-foreground">
                    {orphanSessions.length - maxVisible} more...
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

// ── Chain node (groups sessions by kataIssue within a worktree) ────

/** Pipeline stage order for the 5-dot indicator. */
const CHAIN_STAGES: ReadonlyArray<{ key: string; match: (mode: string) => boolean }> = [
  { key: 'research', match: (m) => m === 'research' },
  { key: 'planning', match: (m) => m === 'planning' },
  { key: 'implementation', match: (m) => m === 'implementation' || m === 'task' },
  { key: 'verify', match: (m) => m === 'verify' },
  { key: 'close', match: (m) => m === 'close' },
]

/** Runner is attached and working (or waiting on user/gate). */
function isLiveStatus(status: string | null | undefined): boolean {
  return (
    status === 'running' ||
    status === 'waiting_input' ||
    status === 'waiting_permission' ||
    status === 'waiting_gate'
  )
}

/** "Completed" — finished a turn and no longer live. */
function isCompletedSession(session: SessionRecord): boolean {
  // Backend parks finished sessions as `idle` (FilterChipBar: 'completed'
  // → s.status === 'idle'). Require at least one turn so fresh drafts
  // don't light up the dot.
  const s = session.status as string
  if (s === 'completed') return true
  return s === 'idle' && (session.numTurns ?? 0) > 0
}

export function PipelineDots({ sessions }: { sessions: SessionRecord[] }) {
  const parts = CHAIN_STAGES.map((stage) => {
    const inStage = sessions.filter((s) => (s.kataMode ? stage.match(s.kataMode) : false))
    if (inStage.some((s) => isLiveStatus(s.status))) {
      return { char: '*', className: 'text-blue-400' }
    }
    if (inStage.some((s) => isCompletedSession(s))) {
      return { char: '\u25CF', className: 'text-foreground' }
    }
    return { char: 'o', className: 'text-muted-foreground' }
  })
  return (
    <span className="ml-auto shrink-0 font-mono text-[10px] leading-none" aria-hidden>
      [
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length stage list
        <span key={i}>
          {i > 0 && <span className="text-muted-foreground">-</span>}
          <span className={p.className}>{p.char}</span>
        </span>
      ))}
      ]
    </span>
  )
}

function ChainNode({
  issueNumber,
  sessions,
  activeSessionId,
  onSelect,
  onRename,
  onArchive,
  onOpenChain,
}: {
  issueNumber: number
  sessions: SessionRecord[]
  activeSessionId: string | null
  onSelect: (session: SessionRecord) => void
  onRename: (sessionId: string, title: string) => void
  onArchive: (sessionId: string, archived: boolean) => void
  onOpenChain: (issueNumber: number) => void
}) {
  const hasActive = sessions.some((s) => s.id === activeSessionId)
  const sorted = [...sessions].sort(byActivity)
  const title = sorted[0]?.title?.trim() || ''

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onOpenChain(issueNumber)
    },
    [issueNumber, onOpenChain],
  )

  return (
    <Collapsible asChild defaultOpen={hasActive} className="group/chain">
      <SidebarMenuSubItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton onDoubleClick={handleDoubleClick}>
            <Layers className="size-3 shrink-0" />
            <span className="truncate">
              {title ? `#${issueNumber} ${title}` : `#${issueNumber}`}
            </span>
            <PipelineDots sessions={sessions} />
            <ChevronRight className="ml-0.5 size-2.5 shrink-0 transition-transform duration-200 group-data-[state=open]/chain:rotate-90" />
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {sorted.map((session) => (
              <SidebarMenuSubItem key={session.id}>
                <SessionContextMenu session={session} onRename={onRename} onArchive={onArchive}>
                  <SidebarMenuSubButton
                    isActive={activeSessionId === session.id}
                    onClick={() => onSelect(session)}
                    title={session.id}
                  >
                    <StatusDot status={session.status || 'idle'} numTurns={session.numTurns ?? 0} />
                    <span className="truncate">{session.kataMode || getDisplayName(session)}</span>
                  </SidebarMenuSubButton>
                </SessionContextMenu>
              </SidebarMenuSubItem>
            ))}
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
                    <StatusDot status={session.status || 'idle'} numTurns={session.numTurns ?? 0} />
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
