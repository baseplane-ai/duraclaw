import { useCallback, useEffect, useState } from 'react'
import { signOut } from '~/lib/auth-client'
import type { ProjectInfo, SessionSummary } from '~/lib/types'
import { cn } from '~/lib/utils'
import {
  Button,
  Dialog,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Textarea,
} from './ui'

type BrowserGlobal = typeof globalThis & {
  window?: unknown
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }
  location?: { pathname: string; href: string }
}

const browserGlobal = globalThis as BrowserGlobal
const isBrowser = typeof browserGlobal.window !== 'undefined'

function storageGet(key: string): string | null {
  return isBrowser ? (browserGlobal.localStorage?.getItem(key) ?? null) : null
}

function storageSet(key: string, value: string): void {
  if (isBrowser) browserGlobal.localStorage?.setItem(key, value)
}

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission'])
const FINISHED_STATUSES = new Set(['idle', 'completed', 'failed', 'aborted'])

interface ProjectWithSessions extends ProjectInfo {
  sessions: SessionSummary[]
}

function navigateTo(path: string) {
  ;(self as unknown as { location: { href: string } }).location.href = path
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-success',
    waiting_input: 'bg-warning',
    waiting_permission: 'bg-warning',
    idle: 'bg-foreground',
    completed: 'bg-foreground',
    failed: 'bg-destructive',
    aborted: 'bg-muted-foreground',
  }

  return (
    <span
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        colors[status] ?? 'bg-muted-foreground',
      )}
    />
  )
}

function SessionItem({
  session,
  selected,
  onSelect,
}: {
  session: SessionSummary
  selected: boolean
  onSelect: (id: string) => void
}) {
  const label = session.summary
    ? session.summary
    : session.prompt
      ? session.prompt.length > 50
        ? `${session.prompt.slice(0, 50)}...`
        : session.prompt
      : session.id.slice(0, 8)

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      className={cn(
        'flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors',
        selected
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      <StatusDot status={session.status} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function FinishedSessionsExpander({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  if (sessions.length === 0) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <span className="text-[10px]">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>{sessions.length} finished</span>
      </button>
      {expanded && (
        <div className="space-y-1">
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              onSelect={onSelect}
              selected={session.id === selectedId}
              session={session}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectFolder({
  project,
  selectedSessionId,
  onSelectSession,
}: {
  project: ProjectWithSessions
  selectedSessionId: string | null
  onSelectSession: (id: string) => void
}) {
  const activeSessions = project.sessions.filter((session) => ACTIVE_STATUSES.has(session.status))
  const finishedSessions = project.sessions.filter((session) =>
    FINISHED_STATUSES.has(session.status),
  )
  const storageKey = `project-expanded-${project.name}`

  const [expanded, setExpanded] = useState(() => {
    const stored = storageGet(storageKey)
    if (stored !== null) return stored === 'true'
    return activeSessions.length > 0
  })

  function toggleExpanded() {
    setExpanded((current) => {
      const next = !current
      storageSet(storageKey, String(next))
      return next
    })
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-medium transition-colors hover:bg-accent/50"
      >
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
          <span>{project.name}</span>
        </span>
        {activeSessions.length > 0 && (
          <span className="text-xs text-muted-foreground">({activeSessions.length})</span>
        )}
      </button>
      {expanded && (
        <div className="space-y-1 pl-2">
          {activeSessions.map((session) => (
            <SessionItem
              key={session.id}
              onSelect={onSelectSession}
              selected={session.id === selectedSessionId}
              session={session}
            />
          ))}
          <FinishedSessionsExpander
            onSelect={onSelectSession}
            selectedId={selectedSessionId}
            sessions={finishedSessions}
          />
        </div>
      )}
    </div>
  )
}

function NewSessionDialog({
  open,
  onClose,
  projects,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  projects: ProjectWithSessions[]
  onSubmit: (data: { project: string; prompt: string; model: string }) => void
}) {
  const [project, setProject] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = project && prompt.trim() && !submitting

  function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      onSubmit({ project, prompt, model })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onClose={onClose} open={open}>
      <DialogHeader>
        <DialogTitle>New Session</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="sidebar-session-project">
            Project
          </label>
          <Select id="sidebar-session-project" value={project} onValueChange={setProject}>
            <option value="">Select a project...</option>
            {projects.map((projectInfo) => {
              const active = projectInfo.sessions.filter((session) =>
                ACTIVE_STATUSES.has(session.status),
              )
              return (
                <option key={projectInfo.name} value={projectInfo.name}>
                  {projectInfo.name} ({projectInfo.branch})
                  {active.length > 0 ? ` - ${active.length} active` : ''}
                </option>
              )
            })}
          </Select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="sidebar-session-prompt">
            Prompt
          </label>
          <Textarea
            className="min-h-[108px]"
            id="sidebar-session-prompt"
            onChange={(event) => setPrompt((event.target as unknown as { value: string }).value)}
            placeholder="What should Claude do?"
            rows={4}
            value={prompt}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="sidebar-session-model">
            Model
          </label>
          <Select id="sidebar-session-model" value={model} onValueChange={setModel}>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-opus-4-6">Claude Opus 4.6</option>
            <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
          </Select>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button className="min-h-11" onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button className="min-h-11" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? 'Launching...' : 'Launch'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function SidebarContent({
  currentSessionId,
  onCloseMobile,
  onOpenNewSession,
  onSelectSession,
  onSignOut,
  onToggleCollapse,
  projects,
  searchQuery,
  setSearchQuery,
  showCollapseToggle,
  showMobileClose,
}: {
  currentSessionId: string | null
  onCloseMobile?: () => void
  onOpenNewSession: () => void
  onSelectSession: (id: string) => void
  onSignOut: () => void
  onToggleCollapse?: () => void
  projects: ProjectWithSessions[]
  searchQuery: string
  setSearchQuery: (value: string) => void
  showCollapseToggle: boolean
  showMobileClose: boolean
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Sessions
            </p>
            <p className="mt-1 text-lg font-semibold">Duraclaw</p>
          </div>
          <div className="flex items-center gap-2">
            {showCollapseToggle && onToggleCollapse && (
              <button
                type="button"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={onToggleCollapse}
                title="Collapse sidebar"
              >
                {'\u00AB'}
              </button>
            )}
            {showMobileClose && onCloseMobile && (
              <button
                type="button"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                data-testid="mobile-drawer-close"
                onClick={onCloseMobile}
                title="Close sessions"
              >
                {'\u2715'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-3 py-3">
        <Input
          className="min-h-11 text-sm"
          data-testid="sidebar-search"
          onChange={(event) => setSearchQuery((event.target as unknown as { value: string }).value)}
          placeholder="Search sessions..."
          value={searchQuery}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 && searchQuery.trim() ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No sessions matching &apos;{searchQuery}&apos;
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <ProjectFolder
                key={project.name}
                onSelectSession={onSelectSession}
                project={project}
                selectedSessionId={currentSessionId}
              />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border px-3 py-3">
        <div className="grid gap-2">
          <Button className="min-h-11 w-full" onClick={onOpenNewSession} variant="outline">
            + New Session
          </Button>
          <Button
            className="min-h-11 w-full text-muted-foreground"
            onClick={onSignOut}
            variant="ghost"
          >
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  )
}

export function ProjectSidebar({
  collapsed,
  mobileOpen,
  onMobileOpenChange,
  onToggleCollapse,
}: {
  collapsed: boolean
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
  onToggleCollapse: () => void
}) {
  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewSession, setShowNewSession] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [projectResponse, sessionResponse] = await Promise.all([
        fetch('/api/projects'),
        fetch('/api/sessions'),
      ])

      let projectList: ProjectInfo[] = []
      let sessionList: SessionSummary[] = []

      if (projectResponse.ok) {
        const data = (await projectResponse.json()) as { projects?: ProjectInfo[] }
        projectList = data.projects ?? []
      }

      if (sessionResponse.ok) {
        const data = (await sessionResponse.json()) as { sessions?: SessionSummary[] }
        sessionList = data.sessions ?? []
      }

      const sessionsByProject = new Map<string, SessionSummary[]>()
      for (const session of sessionList) {
        const list = sessionsByProject.get(session.project) ?? []
        list.push(session)
        sessionsByProject.set(session.project, list)
      }

      setProjects(
        projectList.map((project) => ({
          ...project,
          sessions: sessionsByProject.get(project.name) ?? [],
        })),
      )
    } catch {
      // Ignore sidebar refresh errors; the next poll or navigation can recover.
    }
  }, [])

  useEffect(() => {
    void loadData()
    const interval = setInterval(() => {
      void loadData()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadData])

  function handleNewSession(data: { project: string; prompt: string; model: string }) {
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then((response) => response.json())
      .then((result: unknown) => {
        const payload = result as { session_id?: string }
        if (payload.session_id) {
          setShowNewSession(false)
          onMobileOpenChange(false)
          navigateTo(`/session/${payload.session_id}`)
        }
      })
      .catch(() => {})
  }

  const currentSessionId = isBrowser
    ? (browserGlobal.location?.pathname.match(/^\/session\/(.+)/)?.[1] ?? null)
    : null

  const filteredProjects = searchQuery.trim()
    ? projects
        .map((project) => {
          const query = searchQuery.toLowerCase()
          const projectMatch = project.name.toLowerCase().includes(query)
          const matchingSessions = project.sessions.filter(
            (session) =>
              session.summary?.toLowerCase().includes(query) ||
              session.prompt?.toLowerCase().includes(query),
          )

          if (projectMatch) return project
          if (matchingSessions.length > 0) {
            return { ...project, sessions: matchingSessions }
          }

          return null
        })
        .filter((project): project is ProjectWithSessions => project !== null)
    : projects

  function handleSelectSession(id: string) {
    onMobileOpenChange(false)
    navigateTo(`/session/${id}`)
  }

  function handleSignOut() {
    signOut().finally(() => {
      navigateTo('/login')
    })
  }

  return (
    <>
      {!collapsed && (
        <aside
          className="hidden h-dvh w-72 shrink-0 border-r border-border bg-card/80 backdrop-blur lg:flex"
          data-testid="project-sidebar"
        >
          <SidebarContent
            currentSessionId={currentSessionId}
            onOpenNewSession={() => setShowNewSession(true)}
            onSelectSession={handleSelectSession}
            onSignOut={handleSignOut}
            onToggleCollapse={onToggleCollapse}
            projects={filteredProjects}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            showCollapseToggle
            showMobileClose={false}
          />
        </aside>
      )}

      <Sheet onClose={() => onMobileOpenChange(false)} open={mobileOpen}>
        <SheetContent className="lg:hidden" data-testid="mobile-session-drawer" side="left">
          <SheetHeader className="sr-only">
            <SheetTitle>Sessions</SheetTitle>
          </SheetHeader>
          <SidebarContent
            currentSessionId={currentSessionId}
            onCloseMobile={() => onMobileOpenChange(false)}
            onOpenNewSession={() => setShowNewSession(true)}
            onSelectSession={handleSelectSession}
            onSignOut={handleSignOut}
            projects={filteredProjects}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            showCollapseToggle={false}
            showMobileClose
          />
        </SheetContent>
      </Sheet>

      <NewSessionDialog
        onClose={() => setShowNewSession(false)}
        onSubmit={handleNewSession}
        open={showNewSession}
        projects={projects}
      />
    </>
  )
}
