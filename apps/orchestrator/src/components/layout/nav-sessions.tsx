/**
 * NavSessions — Session list in AppSidebar.
 *
 * Three sections (GH#116 P4b):
 * 1. Recent — flat list of last ~5 sessions (any project), quick-access
 * 2. Arcs — `useLiveQuery(arcsCollection)` filtered to status IN
 *    ('open','draft'). Implicit single-session arcs (no externalRef +
 *    one session + no parent) render as flat session rows so today's
 *    debug/freeform UX is preserved; multi-session and ref-bearing
 *    arcs render as collapsible groups whose label links to
 *    `/arc/:arcId`.
 * 3. Worktrees — repo → worktree (with branch/dirty/PR) → sessions tree
 */

import { useLiveQuery } from '@tanstack/react-db'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { ArchiveIcon, ChevronRight, EditIcon, Eye, EyeOff, FileText, PlusIcon } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { SessionPresenceIcons } from '~/components/session-presence-icons'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import { VisibilityBadge } from '~/components/visibility-badge'
import { arcsCollection } from '~/db/arcs-collection'
import { projectsCollection } from '~/db/projects-collection'
import type { SessionRecord } from '~/db/session-record'
import { userPreferencesCollection } from '~/db/user-preferences-collection'
import { getPreviewText, StatusDot } from '~/features/agent-orch/session-utils'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import { newDraftTabId, useTabSync } from '~/hooks/use-tab-sync'
import { useSession as useAuthSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'
import type { ArcSummary, PrInfo, ProjectInfo, SessionStatus } from '~/lib/types'
import { cn } from '~/lib/utils'
import { filterSessionsByMode, type SessionFilterMode } from './nav-sessions-filter'

/**
 * GH#116 P4b: an arc qualifies as an "implicit single-session arc"
 * when it has no externalRef, exactly one session, and no parent arc.
 * Those arcs were minted automatically by `createSession` (debug /
 * freeform / orphan spawns) and shouldn't add a collapsible layer to
 * the sidebar — they render as flat session rows so today's
 * one-session = one-row UX is preserved.
 *
 * Pure / exported for unit testing — no React, no hooks. Uses `==` on
 * `parentArcId` to treat `null` and `undefined` (the optional field)
 * as equivalent.
 */
export function isImplicitSingleSessionArc(arc: ArcSummary): boolean {
  return (
    arc.externalRef === null &&
    arc.sessions.length === 1 &&
    (arc.parentArcId === null || arc.parentArcId === undefined)
  )
}

const SESSION_FILTER_STORAGE_KEY = 'duraclaw.session-filter'

function readInitialFilterMode(): SessionFilterMode {
  if (typeof window === 'undefined') return 'all'
  const raw = window.localStorage.getItem(SESSION_FILTER_STORAGE_KEY)
  return raw === 'mine' ? 'mine' : 'all'
}

/** ProjectInfo extended with the `hidden` flag added by the API route */
interface ProjectInfoWithHidden extends ProjectInfo {
  hidden: boolean
}

function getDisplayName(session: SessionRecord): string {
  return session.title || getPreviewText(session) || session.id.slice(0, 8)
}

/**
 * Truncated label that reveals the full text in a tooltip on hover.
 * Used for worktree/project/session names which frequently overflow the
 * narrow sidebar column. Rendered as the `last-child` span of a menu
 * button so the parent's `[&>span:last-child]:truncate` rule applies.
 */
function TruncatedText({
  children,
  tooltip,
  className,
}: {
  children: React.ReactNode
  tooltip?: React.ReactNode
  className?: string
}) {
  const tip = tooltip ?? children
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span className={cn('truncate', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs break-all">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
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

/**
 * Sort by lastActivity DESC, NULLs last (fall back to updated_at within NULL
 * group). Timestamps are coarsened to 5-second buckets before comparison and
 * tie-broken by `createdAt` DESC then `id`, so sub-second `last_activity`
 * bumps from concurrent agent turns don't leap-frog rows in the sidebar.
 * Any change at the 5-second granularity still reorders normally.
 */
const ACTIVITY_BUCKET_MS = 5_000
function byActivity(a: SessionRecord, b: SessionRecord): number {
  const aHas = !!a.lastActivity
  const bHas = !!b.lastActivity
  if (aHas !== bHas) return aHas ? -1 : 1
  const aBucket = Math.floor(new Date(a.lastActivity ?? a.updatedAt).getTime() / ACTIVITY_BUCKET_MS)
  const bBucket = Math.floor(new Date(b.lastActivity ?? b.updatedAt).getTime() / ACTIVITY_BUCKET_MS)
  if (aBucket !== bBucket) return bBucket - aBucket
  const aCreated = new Date(a.createdAt).getTime()
  const bCreated = new Date(b.createdAt).getTime()
  if (aCreated !== bCreated) return bCreated - aCreated
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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

  // Spec #68 B11: client-side "All / Mine" filter. Default 'all' — server
  // list already widens to `user_id = ? OR visibility = 'public'`.
  const { data: authSession } = useAuthSession()
  const currentUserId = (authSession as { user?: { id?: string } } | null)?.user?.id ?? null
  const [filterMode, setFilterMode] = useState<SessionFilterMode>(() => readInitialFilterMode())
  const [recentExpanded, setRecentExpanded] = useState(false)
  const handleFilterChange = useCallback((mode: SessionFilterMode) => {
    setFilterMode(mode)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SESSION_FILTER_STORAGE_KEY, mode)
    }
  }, [])

  // Synced collections: projects + user preferences (GH#32 phase p4).
  // Replaces the old direct GET /api/gateway/projects/all client fetch —
  // the projects collection is now driven by UserSettingsDO delta frames
  // and D1-authoritative /api/projects cold-start queryFn.
  const { data: projectRows } = useLiveQuery(projectsCollection as any)
  const { data: prefsRows } = useLiveQuery(userPreferencesCollection as any)
  // GH#116 P4b: arcs section — only `open` / `draft` arcs surface in
  // the sidebar (closed/archived arcs are reachable via /board only).
  const { data: arcRows } = useLiveQuery(arcsCollection as any)
  const openArcs = useMemo<ArcSummary[]>(() => {
    const list = (arcRows ?? []) as ArcSummary[]
    return list.filter((a) => a.status === 'open' || a.status === 'draft')
  }, [arcRows])

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

  // GH#122 B-UI-6/B-UI-7: project name → projectId resolver for the
  // session-card "Open Docs" icon-button. Returns null when the project
  // has no projectId yet (gateway hasn't synced post-migration, or the
  // clone has no remote origin).
  const projectIdByName = useMemo(() => {
    const list = (projectRows ?? []) as ProjectInfo[]
    const out: Record<string, string | null> = {}
    for (const p of list) out[p.name] = p.projectId ?? null
    return out
  }, [projectRows])

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

  // Perf: memoize the whole visible/recent/sessionsByProject/repo/orphan
  // derivation on `[sessions, projects]`. These maps were previously rebuilt
  // on every NavSessions render — including unrelated renders triggered by
  // ANY hook update in this component — producing new Map/array references
  // every time and cascading re-renders into `RepoGroup` / `WorktreeNode`
  // children. With `useMemo` we only rebuild when the underlying collections
  // actually change.
  const { visible, recent, sessionsByProject } = useMemo(() => {
    const notArchived = sessions.filter((s) => !s.archived)
    const visible = filterSessionsByMode(notArchived, filterMode, currentUserId)
    const recent = [...visible].sort(byActivity).slice(0, 25)

    const sessionsByProject = new Map<string, SessionRecord[]>()
    for (const session of visible) {
      const key = session.project || 'unknown'
      if (!sessionsByProject.has(key)) sessionsByProject.set(key, [])
      sessionsByProject.get(key)?.push(session)
    }
    for (const [, projectSessions] of sessionsByProject) {
      projectSessions.sort(byActivity)
    }
    return { visible, recent, sessionsByProject }
  }, [sessions, filterMode, currentUserId])

  const repoGroups = useMemo(() => {
    const repoGroups = new Map<string, ProjectInfoWithHidden[]>()
    for (const project of projects) {
      const key = project.repo_origin || 'Unknown'
      if (!repoGroups.has(key)) repoGroups.set(key, [])
      repoGroups.get(key)?.push(project)
    }
    return repoGroups
  }, [projects])

  const orphanGroups = useMemo(() => {
    const knownProjectNames = new Set(projects.map((p) => p.name))
    const orphanGroups = new Map<string, SessionRecord[]>()
    for (const [projectName, projectSessions] of sessionsByProject) {
      if (!knownProjectNames.has(projectName)) {
        orphanGroups.set(projectName, projectSessions)
      }
    }
    return orphanGroups
  }, [projects, sessionsByProject])

  const handleSelect = useCallback(
    (session: SessionRecord) => {
      // Navigation to /?session=X triggers AgentOrchPage's deep-link effect,
      // which calls openTab() on userTabsCollection. No direct tab manipulation needed.
      setOpenMobile(false)
      navigate({ to: '/', search: { session: session.id } })
    },
    [setOpenMobile, navigate],
  )

  // GH#116 P4b: lightweight "select session by id" for ArcGroup rows
  // (the Arcs section gets ArcSummary['sessions'][number], not the
  // richer SessionRecord, so it routes by id directly).
  const handleSelectSessionById = useCallback(
    (sessionId: string) => {
      setOpenMobile(false)
      navigate({ to: '/', search: { session: sessionId } })
    },
    [setOpenMobile, navigate],
  )

  // GH#116 P4b: navigate to /arc/:arcId for multi-session arcs.
  const handleOpenArc = useCallback(
    (arcId: string) => {
      setOpenMobile(false)
      navigate({ to: '/arc/$arcId', params: { arcId } })
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

  // Chain double-click → navigate to the chain's latest session.
  // (Spec #58 P1 removed the dedicated /chain/:issueNumber route; chain
  // context now surfaces via the StatusBar widget on the session tab.)
  const handleOpenChain = useCallback(
    (issueNumber: number) => {
      const chainSessions = sessions.filter((s) => s.kataIssue === issueNumber)
      if (chainSessions.length === 0) return
      const sorted = [...chainSessions].sort((a, b) => {
        const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
        const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
        return bTime - aTime
      })
      const latest = sorted[0]
      if (!latest) return
      openTab(latest.id, { project: latest.project })
      setOpenMobile(false)
      navigate({ to: '/', search: { session: latest.id } })
    },
    [openTab, navigate, setOpenMobile, sessions],
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

      {/* Spec #68 B11: All / Mine filter toggle */}
      <SidebarGroup>
        <div className="flex gap-1 px-2">
          <button
            type="button"
            onClick={() => handleFilterChange('all')}
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs',
              filterMode === 'all'
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50',
            )}
          >
            All Sessions
          </button>
          <button
            type="button"
            onClick={() => handleFilterChange('mine')}
            className={cn(
              'flex-1 rounded px-2 py-1 text-xs',
              filterMode === 'mine'
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50',
            )}
          >
            My Sessions
          </button>
        </div>
      </SidebarGroup>

      {/* Recent sessions */}
      <SidebarGroup>
        <SidebarGroupLabel>Recent</SidebarGroupLabel>
        <SidebarMenu>
          {(recentExpanded ? recent : recent.slice(0, 5)).map((session) => (
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
                  <StatusDot
                    status={session.status as SessionStatus}
                    numTurns={session.numTurns ?? 0}
                  />
                  <SessionPresenceIcons sessionId={session.id} />
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1 truncate text-sm leading-tight">
                      <TruncatedText tooltip={`${getDisplayName(session)} — ${session.project}`}>
                        {getDisplayName(session)}
                      </TruncatedText>
                      {currentUserId && session.userId !== currentUserId && (
                        <VisibilityBadge
                          visibility={session.visibility}
                          className="ml-1 shrink-0"
                        />
                      )}
                    </span>
                    <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground leading-tight">
                      <span className="truncate">{session.project}</span>
                      {/* GH#122 B-UI-6: Open Docs icon-button — only renders
                          when the synced projectsCollection has a projectId
                          for this session's project (NULL until backfill
                          runs / next gateway sync). Click does NOT propagate
                          to the parent SessionMenuButton's onClick. */}
                      {projectIdByName[session.project] && (
                        <Link
                          to="/projects/$projectId/docs"
                          params={{ projectId: projectIdByName[session.project] as string }}
                          aria-label={`Open docs for ${session.project}`}
                          onClick={(e) => e.stopPropagation()}
                          className="opacity-60 transition-opacity hover:opacity-100 focus:opacity-100"
                        >
                          <FileText className="size-3.5" />
                        </Link>
                      )}
                    </span>
                    {session.identityName && (
                      <span className="truncate text-[10px] text-muted-foreground leading-tight">
                        {session.identityName}
                      </span>
                    )}
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
          {recent.length > 5 && (
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => setRecentExpanded((v) => !v)}>
                <span className="text-xs text-muted-foreground">
                  {recentExpanded ? 'Show less' : `${recent.length - 5} more…`}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroup>

      {/* Arcs section (GH#116 P4b) — between Recent and Worktrees.
          Implicit single-session arcs render as flat session rows (no
          collapsible group); other arcs render as ArcGroup linking to
          /arc/:arcId with their sessions nested below. */}
      <SidebarGroup>
        <SidebarGroupLabel>Arcs</SidebarGroupLabel>
        <SidebarMenu>
          {openArcs.length === 0 ? (
            <SidebarMenuItem>
              <SidebarMenuButton disabled>
                <span className="text-muted-foreground">No active arcs</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            openArcs.map((arc) => {
              if (isImplicitSingleSessionArc(arc)) {
                const arcSession = arc.sessions[0]
                if (!arcSession) return null
                // The Arc's session shape is a thin projection; reach
                // for the full SessionRecord (with title, project, etc.)
                // when available so the row matches the Recent section's
                // density.
                const fullSession = sessions.find((s) => s.id === arcSession.id)
                return (
                  <SidebarMenuItem key={arc.id}>
                    {fullSession ? (
                      <SessionContextMenu
                        session={fullSession}
                        onRename={handleRename}
                        onArchive={handleArchive}
                      >
                        <SidebarMenuButton
                          isActive={activeSessionId === fullSession.id}
                          tooltip={`${getDisplayName(fullSession)} — ${fullSession.project}`}
                          onClick={() => handleSelect(fullSession)}
                        >
                          <StatusDot
                            status={fullSession.status as SessionStatus}
                            numTurns={fullSession.numTurns ?? 0}
                          />
                          <TruncatedText>{arc.title || getDisplayName(fullSession)}</TruncatedText>
                        </SidebarMenuButton>
                      </SessionContextMenu>
                    ) : (
                      <SidebarMenuButton
                        isActive={activeSessionId === arcSession.id}
                        onClick={() => handleSelectSessionById(arcSession.id)}
                      >
                        <StatusDot status={arcSession.status as SessionStatus} numTurns={0} />
                        <TruncatedText>{arc.title || arcSession.id.slice(0, 8)}</TruncatedText>
                      </SidebarMenuButton>
                    )}
                  </SidebarMenuItem>
                )
              }
              return (
                <ArcGroup
                  key={arc.id}
                  arc={arc}
                  activeSessionId={activeSessionId}
                  onOpenArc={handleOpenArc}
                  onSelectSession={handleSelectSessionById}
                />
              )
            })
          )}
        </SidebarMenu>
      </SidebarGroup>

      {/* Unified worktree tree: repo → worktree (branch/dirty/PR) → sessions */}
      <SidebarGroup>
        <SidebarGroupLabel>Worktrees</SidebarGroupLabel>
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
            <ChevronRight className="size-3 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
            <TruncatedText>{orgRepo}</TruncatedText>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {projects.length}
            </span>
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
        <SidebarMenuSubButton className={cn('group/wt h-auto py-1', isHidden && 'opacity-40')}>
          <div className="flex min-w-0 flex-1 flex-col">
            <TruncatedText
              className="text-sm leading-tight"
              tooltip={`${project.name} — ${project.branch}`}
            >
              {project.name}
            </TruncatedText>
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
          <SidebarMenuSubButton className={cn('h-auto py-1', isHidden && 'opacity-40')}>
            <ChevronRight className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/wt-col:rotate-90" />
            <div className="flex min-w-0 flex-1 flex-col">
              <TruncatedText
                className="text-sm leading-tight"
                tooltip={`${project.name} — ${project.branch}`}
              >
                {project.name}
              </TruncatedText>
              <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground leading-tight">
                {project.branch}
                <WorktreeIndicators project={project} />
              </span>
            </div>
            <span className="shrink-0 text-[10px] text-muted-foreground">{sessions.length}</span>
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
                    <StatusDot
                      status={session.status as SessionStatus}
                      numTurns={session.numTurns ?? 0}
                    />
                    <TruncatedText>{getDisplayName(session)}</TruncatedText>
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
function isCompletedSession(session: SessionRecord, derivedStatus: string): boolean {
  // Backend parks finished sessions as `idle` (FilterChipBar: 'completed'
  // → s.status === 'idle'). Require at least one turn so fresh drafts
  // don't light up the dot.
  if (derivedStatus === 'completed') return true
  return derivedStatus === 'idle' && (session.numTurns ?? 0) > 0
}

export function PipelineDots({ sessions }: { sessions: SessionRecord[] }) {
  const parts = CHAIN_STAGES.map((stage) => {
    const inStage = sessions.filter((s) => (s.kataMode ? stage.match(s.kataMode) : false))
    const inStageDerived = inStage.map((s) => ({ session: s, status: s.status as SessionStatus }))
    if (inStageDerived.some(({ status }) => isLiveStatus(status))) {
      return { char: '*', className: 'text-blue-400' }
    }
    if (inStageDerived.some(({ session, status }) => isCompletedSession(session, status))) {
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
            <ChevronRight className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/chain:rotate-90" />
            <TruncatedText tooltip={title ? `#${issueNumber} ${title}` : `#${issueNumber}`}>
              {title ? `#${issueNumber} ${title}` : `#${issueNumber}`}
            </TruncatedText>
            <PipelineDots sessions={sessions} />
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
                    <StatusDot
                      status={session.status as SessionStatus}
                      numTurns={session.numTurns ?? 0}
                    />
                    <TruncatedText tooltip={getDisplayName(session)}>
                      {session.kataMode || getDisplayName(session)}
                    </TruncatedText>
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
            <ChevronRight className="size-3 text-muted-foreground transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
            <TruncatedText className="text-muted-foreground">{project}</TruncatedText>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {sessions.length}
            </span>
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
                      status={session.status as SessionStatus}
                      numTurns={session.numTurns ?? 0}
                    />
                    <TruncatedText>{getDisplayName(session)}</TruncatedText>
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

// ── Arc group (GH#116 P4b) ────────────────────────────────────────
//
// Multi-session arcs and ref-bearing arcs render here. Header label
// links to /arc/:arcId via `onOpenArc`; expand chevron toggles the
// nested session list. Implicit single-session arcs are rendered
// inline (flat) by NavSessions and never reach this component — see
// `isImplicitSingleSessionArc`.

function ArcGroup({
  arc,
  activeSessionId,
  onOpenArc,
  onSelectSession,
}: {
  arc: ArcSummary
  activeSessionId: string | null
  onOpenArc: (arcId: string) => void
  onSelectSession: (sessionId: string) => void
}) {
  const hasActive = arc.sessions.some((s) => s.id === activeSessionId)
  const sortedSessions = [...arc.sessions].sort((a, b) => {
    const aTs = new Date(a.lastActivity ?? a.createdAt).getTime()
    const bTs = new Date(b.lastActivity ?? b.createdAt).getTime()
    return bTs - aTs
  })
  const externalLabel =
    arc.externalRef?.provider === 'github'
      ? `#${String(arc.externalRef.id)}`
      : arc.externalRef
        ? `${arc.externalRef.provider}:${String(arc.externalRef.id)}`
        : null

  return (
    <Collapsible asChild defaultOpen={hasActive} className="group/arc">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            tooltip={arc.title}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenArc(arc.id)
            }}
          >
            <ChevronRight className="size-3 shrink-0 transition-transform duration-200 group-data-[state=open]/arc:rotate-90" />
            {externalLabel && (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {externalLabel}
              </span>
            )}
            <TruncatedText>{arc.title}</TruncatedText>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {arc.sessions.length}
            </span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            <SidebarMenuSubItem>
              <SidebarMenuSubButton onClick={() => onOpenArc(arc.id)}>
                <span className="text-muted-foreground text-xs">Open arc detail →</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
            {sortedSessions.map((session) => (
              <SidebarMenuSubItem key={session.id}>
                <SidebarMenuSubButton
                  isActive={activeSessionId === session.id}
                  onClick={() => onSelectSession(session.id)}
                  title={session.id}
                >
                  <StatusDot status={session.status as SessionStatus} numTurns={0} />
                  <TruncatedText>{session.mode || session.id.slice(0, 8)}</TruncatedText>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
