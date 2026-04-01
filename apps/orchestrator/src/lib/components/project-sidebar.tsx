import { useEffect, useState } from 'react'
import { Button, Dialog, DialogHeader, DialogTitle, Input, Select, Textarea } from './ui'
import { cn } from '~/lib/utils'
import type { SessionSummary, ProjectInfo } from '~/lib/types'

// ── Browser Helpers ────────────────────────────────────────────────

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

// ── Constants ──────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission'])
const FINISHED_STATUSES = new Set(['idle', 'completed', 'failed', 'aborted'])

// ── Types ──────────────────────────────────────────────────────────

interface ProjectWithSessions extends ProjectInfo {
  sessions: SessionSummary[]
}

// ── Status Icon ────────────────────────────────────────────────────

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
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', colors[status] ?? 'bg-muted-foreground')}
    />
  )
}

// ── Session Item ───────────────────────────────────────────────────

function SessionItem({ session, selected }: { session: SessionSummary; selected: boolean }) {
  const label = session.summary
    ? session.summary
    : session.prompt
      ? session.prompt.length > 50
        ? `${session.prompt.slice(0, 50)}...`
        : session.prompt
      : session.id.slice(0, 8)

  function handleClick() {
    ;(self as unknown as { location: { href: string } }).location.href = `/session/${session.id}`
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors',
        selected
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <StatusDot status={session.status} />
      <span className="truncate">{label}</span>
    </button>
  )
}

// ── Finished Sessions Expander ─────────────────────────────────────

function FinishedSessionsExpander({
  sessions,
  selectedId,
}: {
  sessions: SessionSummary[]
  selectedId: string | null
}) {
  const [expanded, setExpanded] = useState(false)

  if (sessions.length === 0) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="text-[10px]">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span>{sessions.length} finished</span>
      </button>
      {expanded && (
        <div className="space-y-0.5">
          {sessions.map((s) => (
            <SessionItem key={s.id} session={s} selected={s.id === selectedId} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Project Folder ─────────────────────────────────────────────────

function ProjectFolder({
  project,
  selectedSessionId,
}: {
  project: ProjectWithSessions
  selectedSessionId: string | null
}) {
  const activeSessions = project.sessions.filter((s) => ACTIVE_STATUSES.has(s.status))
  const finishedSessions = project.sessions.filter((s) => FINISHED_STATUSES.has(s.status))
  const hasActive = activeSessions.length > 0

  const storageKey = `project-expanded-${project.name}`
  const [expanded, setExpanded] = useState(() => {
    const stored = storageGet(storageKey)
    if (stored !== null) return stored === 'true'
    return hasActive
  })

  function toggleExpanded() {
    const next = !expanded
    setExpanded(next)
    storageSet(storageKey, String(next))
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-center justify-between px-3 py-1.5 text-sm font-medium hover:bg-accent/50 rounded-md transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">{expanded ? '\u25BC' : '\u25B6'}</span>
          <span>{project.name}</span>
        </div>
        {activeSessions.length > 0 && (
          <span className="text-xs text-muted-foreground">({activeSessions.length})</span>
        )}
      </button>
      {expanded && (
        <div className="ml-2 space-y-0.5 mt-0.5">
          {activeSessions.map((s) => (
            <SessionItem key={s.id} session={s} selected={s.id === selectedSessionId} />
          ))}
          <FinishedSessionsExpander sessions={finishedSessions} selectedId={selectedSessionId} />
        </div>
      )}
    </div>
  )
}

// ── New Session Dialog ─────────────────────────────────────────────

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
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>New Session</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Project</label>
          <Select value={project} onValueChange={setProject}>
            <option value="">Select a project...</option>
            {projects.map((p) => {
              const active = p.sessions.filter((s) => ACTIVE_STATUSES.has(s.status))
              return (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.branch}){active.length > 0 ? ` - ${active.length} active` : ''}
                </option>
              )
            })}
          </Select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">Prompt</label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt((e.target as unknown as { value: string }).value)}
            placeholder="What should Claude do?"
            rows={4}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">Model</label>
          <Select value={model} onValueChange={setModel}>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-opus-4-6">Claude Opus 4.6</option>
            <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
          </Select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? 'Launching...' : 'Launch'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// ── Project Sidebar ────────────────────────────────────────────────

export function ProjectSidebar({
  collapsed,
  onToggleCollapse,
}: {
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showNewSession, setShowNewSession] = useState(false)

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 5000)
    return () => clearInterval(interval)
  }, [])

  async function loadData() {
    try {
      const [projRes, sessRes] = await Promise.all([
        fetch('/api/projects'),
        fetch('/api/sessions'),
      ])
      let projectList: ProjectInfo[] = []
      let sessionList: SessionSummary[] = []
      if (projRes.ok) {
        const data = (await projRes.json()) as { projects?: ProjectInfo[] }
        projectList = data.projects ?? []
      }
      if (sessRes.ok) {
        const data = (await sessRes.json()) as { sessions?: SessionSummary[] }
        sessionList = data.sessions ?? []
      }
      // Group sessions by project
      const sessionsByProject = new Map<string, SessionSummary[]>()
      for (const s of sessionList) {
        const arr = sessionsByProject.get(s.project) ?? []
        arr.push(s)
        sessionsByProject.set(s.project, arr)
      }
      const merged: ProjectWithSessions[] = projectList.map((p) => ({
        ...p,
        sessions: sessionsByProject.get(p.name) ?? [],
      }))
      setProjects(merged)
    } catch {
      // Silently handle fetch errors
    }
  }

  function handleNewSession(data: { project: string; prompt: string; model: string }) {
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then((res) => res.json())
      .then((result: unknown) => {
        const r = result as { session_id?: string }
        if (r.session_id) {
          setShowNewSession(false)
          ;(self as unknown as { location: { href: string } }).location.href =
            `/session/${r.session_id}`
        }
      })
      .catch(() => {})
  }

  // Get current session ID from URL
  const currentSessionId = isBrowser
    ? (browserGlobal.location?.pathname.match(/^\/session\/(.+)/)?.[1] ?? null)
    : null

  // Filter projects and sessions by search query
  const filteredProjects = searchQuery.trim()
    ? projects
        .map((p) => {
          const q = searchQuery.toLowerCase()
          const matchingSessions = p.sessions.filter(
            (s) =>
              (s.summary && s.summary.toLowerCase().includes(q)) ||
              (s.prompt && s.prompt.toLowerCase().includes(q)),
          )
          const projectNameMatches = p.name.toLowerCase().includes(q)
          if (projectNameMatches) return p
          if (matchingSessions.length > 0) return { ...p, sessions: matchingSessions }
          return null
        })
        .filter((p): p is ProjectWithSessions => p !== null)
    : projects

  if (collapsed) return null

  return (
    <>
      <aside className="flex h-full w-70 shrink-0 flex-col border-r border-border bg-card">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-bold">Duraclaw</span>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Collapse sidebar"
          >
            {'\u00AB'}
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <Input
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery((e.target as unknown as { value: string }).value)}
            className="h-8 text-xs"
          />
        </div>

        {/* Project Tree */}
        <div className="flex-1 overflow-y-auto px-1 py-1">
          {filteredProjects.length === 0 && searchQuery.trim() ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No sessions matching &apos;{searchQuery}&apos;
            </div>
          ) : (
            <div className="space-y-1">
              {filteredProjects.map((p) => (
                <ProjectFolder
                  key={p.name}
                  project={p}
                  selectedSessionId={currentSessionId}
                />
              ))}
            </div>
          )}
        </div>

        {/* New Session Button */}
        <div className="border-t border-border p-3">
          <Button
            variant="outline"
            className="w-full text-sm"
            onClick={() => setShowNewSession(true)}
          >
            + New
          </Button>
        </div>
      </aside>

      <NewSessionDialog
        open={showNewSession}
        onClose={() => setShowNewSession(false)}
        projects={projects}
        onSubmit={handleNewSession}
      />
    </>
  )
}
