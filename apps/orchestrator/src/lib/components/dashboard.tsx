import { useCallback, useEffect, useState } from 'react'
import type { ProjectInfo, SessionSummary } from '~/lib/types'
import { cn } from '~/lib/utils'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogHeader,
  DialogTitle,
  Select,
  Skeleton,
  Textarea,
} from './ui'

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    {
      label: string
      variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
    }
  > = {
    running: { variant: 'success', label: 'Running' },
    waiting_input: { variant: 'warning', label: 'Waiting' },
    waiting_permission: { variant: 'warning', label: 'Permission' },
    completed: { variant: 'secondary', label: 'Completed' },
    failed: { variant: 'destructive', label: 'Failed' },
    aborted: { variant: 'outline', label: 'Aborted' },
    idle: { variant: 'outline', label: 'Idle' },
  }

  const value = variants[status] ?? { variant: 'outline' as const, label: status }
  return <Badge variant={value.variant}>{value.label}</Badge>
}

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission'])

interface ProjectWithSessions extends ProjectInfo {
  sessions?: SessionSummary[]
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function ProjectGrid({ loading, projects }: { loading: boolean; projects: ProjectWithSessions[] }) {
  if (loading) {
    const skeletonIds = [
      'dashboard-skeleton-1',
      'dashboard-skeleton-2',
      'dashboard-skeleton-3',
      'dashboard-skeleton-4',
      'dashboard-skeleton-5',
      'dashboard-skeleton-6',
    ]

    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {skeletonIds.map((skeletonId) => (
          <Skeleton key={skeletonId} className="h-28 rounded-2xl" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => {
        const activeSessions = (project.sessions ?? []).filter((session) =>
          ACTIVE_STATUSES.has(session.status),
        )

        return (
          <Card key={project.name} className="rounded-2xl border-border/80 bg-card/80">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <CardTitle className="truncate">{project.name}</CardTitle>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge className="max-w-full truncate text-xs" variant="outline">
                      {project.branch}
                    </Badge>
                    {project.dirty && <span className="text-warning">Uncommitted changes</span>}
                  </div>
                </div>
                <span
                  className={cn(
                    'mt-1 h-2.5 w-2.5 rounded-full',
                    activeSessions.length > 0 ? 'bg-success' : 'bg-muted-foreground/30',
                  )}
                  title={
                    activeSessions.length > 0
                      ? `${activeSessions.length} active session(s)`
                      : 'No active sessions'
                  }
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {activeSessions.length > 0 ? (
                  <span className="text-success">{activeSessions.length} active</span>
                ) : (
                  <span>{(project.sessions ?? []).length} session(s)</span>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function SessionList({
  onSelect,
  sessions,
  title,
}: {
  onSelect: (id: string) => void
  sessions: SessionSummary[]
  title: string
}) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No {title.toLowerCase()}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {sessions.map((session) => (
        <button
          key={session.id}
          className="flex min-h-11 w-full items-start justify-between gap-3 rounded-2xl border border-border bg-card/70 px-4 py-3 text-left transition-colors hover:bg-accent/40"
          onClick={() => onSelect(session.id)}
          type="button"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{session.project}</span>
              <StatusBadge status={session.status} />
            </div>
            {session.prompt && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {session.prompt.slice(0, 90)}
                {session.prompt.length > 90 ? '...' : ''}
              </p>
            )}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTime(session.created_at)}
          </span>
        </button>
      ))}
    </div>
  )
}

function NewSessionDialog({
  onClose,
  onSubmit,
  open,
  projects,
}: {
  onClose: () => void
  onSubmit: (data: { model: string; project: string; prompt: string }) => void
  open: boolean
  projects: ProjectWithSessions[]
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
          <label className="mb-1.5 block text-sm font-medium" htmlFor="dashboard-session-project">
            Project
          </label>
          <Select id="dashboard-session-project" value={project} onValueChange={setProject}>
            <option value="">Select a project...</option>
            {projects.map((projectInfo) => (
              <option key={projectInfo.name} value={projectInfo.name}>
                {projectInfo.name} ({projectInfo.branch})
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="dashboard-session-prompt">
            Prompt
          </label>
          <Textarea
            className="min-h-[108px]"
            id="dashboard-session-prompt"
            onChange={(event) => setPrompt((event.target as unknown as { value: string }).value)}
            placeholder="What should Claude do?"
            rows={4}
            value={prompt}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium" htmlFor="dashboard-session-model">
            Model
          </label>
          <Select id="dashboard-session-model" value={model} onValueChange={setModel}>
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

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessions, setActiveSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewSession, setShowNewSession] = useState(false)
  const [tab, setTab] = useState<'active' | 'history'>('active')

  const loadData = useCallback(async () => {
    try {
      const [projectResponse, sessionResponse, activeResponse] = await Promise.all([
        fetch('/api/projects'),
        fetch('/api/sessions'),
        fetch('/api/sessions/active'),
      ])

      if (projectResponse.ok) {
        const data = (await projectResponse.json()) as { projects?: ProjectWithSessions[] }
        setProjects(data.projects ?? [])
      }

      if (sessionResponse.ok) {
        const data = (await sessionResponse.json()) as { sessions?: SessionSummary[] }
        setSessions(data.sessions ?? [])
      }

      if (activeResponse.ok) {
        const data = (await activeResponse.json()) as { sessions?: SessionSummary[] }
        setActiveSessions(data.sessions ?? [])
      }
    } catch {
      // Ignore transient dashboard refresh failures; the next poll can recover.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
    const interval = setInterval(() => {
      void loadData()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadData])

  function handleNewSession(data: { model: string; project: string; prompt: string }) {
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
          ;(self as unknown as { location: { href: string } }).location.href =
            `/session/${payload.session_id}`
        }
      })
      .catch(() => {})
  }

  return (
    <main className="min-h-dvh px-4 pb-24 pt-20 sm:px-6 sm:pb-8 lg:px-10 lg:pt-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-col gap-4 rounded-[28px] border border-border/70 bg-card/75 p-5 shadow-sm backdrop-blur sm:flex-row sm:items-end sm:justify-between sm:p-6">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Workspace
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Start a new session, pick up an active thread, or scan recent history from the same
              shell the mobile navigation uses.
            </p>
          </div>
          <Button className="min-h-11 sm:min-w-40" onClick={() => setShowNewSession(true)}>
            New Session
          </Button>
        </header>

        <section className="space-y-3" data-testid="dashboard-projects">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Projects
            </h2>
            <span className="text-xs text-muted-foreground">{projects.length} discovered</span>
          </div>
          <ProjectGrid loading={loading} projects={projects} />
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-11"
              onClick={() => setTab('active')}
              variant={tab === 'active' ? 'default' : 'ghost'}
            >
              Active ({activeSessions.length})
            </Button>
            <Button
              className="min-h-11"
              onClick={() => setTab('history')}
              variant={tab === 'history' ? 'default' : 'ghost'}
            >
              History
            </Button>
          </div>
          {tab === 'active' ? (
            <SessionList
              onSelect={(id) => {
                ;(self as unknown as { location: { href: string } }).location.href =
                  `/session/${id}`
              }}
              sessions={activeSessions}
              title="active sessions"
            />
          ) : (
            <SessionList
              onSelect={(id) => {
                ;(self as unknown as { location: { href: string } }).location.href =
                  `/session/${id}`
              }}
              sessions={sessions}
              title="sessions"
            />
          )}
        </section>
      </div>

      <NewSessionDialog
        onClose={() => setShowNewSession(false)}
        onSubmit={handleNewSession}
        open={showNewSession}
        projects={projects}
      />
    </main>
  )
}
