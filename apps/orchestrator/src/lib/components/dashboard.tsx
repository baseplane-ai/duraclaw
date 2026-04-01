import { useEffect, useState } from 'react'
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
import { cn } from '~/lib/utils'
import type { SessionSummary, ProjectInfo } from '~/lib/types'

// ── Status Badge ────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const variants: Record<
    string,
    {
      variant: 'default' | 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
      label: string
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
  const v = variants[status] ?? { variant: 'outline' as const, label: status }
  return <Badge variant={v.variant}>{v.label}</Badge>
}

// ── Project Grid ────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['running', 'waiting_input', 'waiting_permission'])

interface ProjectWithSessions extends ProjectInfo {
  sessions?: SessionSummary[]
}

function ProjectGrid({
  projects,
  loading,
}: {
  projects: ProjectWithSessions[]
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((wt) => {
        const activeSessions = (wt.sessions ?? []).filter((s) => ACTIVE_STATUSES.has(s.status))
        const hasActive = activeSessions.length > 0
        return (
          <Card key={wt.name}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle>{wt.name}</CardTitle>
                <div className="flex items-center gap-1.5">
                  {wt.dirty && (
                    <span
                      className="h-2 w-2 rounded-full bg-warning"
                      title="Uncommitted changes"
                    />
                  )}
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      hasActive ? 'bg-success' : 'bg-muted-foreground/30',
                    )}
                    title={hasActive ? `${activeSessions.length} active session(s)` : 'No active sessions'}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="text-xs">
                  {wt.branch}
                </Badge>
                {hasActive && (
                  <span className="text-xs text-success">
                    {activeSessions.length} active
                  </span>
                )}
                {(wt.sessions ?? []).length > 0 && !hasActive && (
                  <span className="text-xs">
                    {(wt.sessions ?? []).length} session(s)
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ── Session List ────────────────────────────────────────────────────

function SessionList({
  sessions,
  title,
  onSelect,
}: {
  sessions: SessionSummary[]
  title: string
  onSelect: (id: string) => void
}) {
  if (sessions.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">
        No {title.toLowerCase()}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onSelect(s.id)}
          className="flex w-full items-center justify-between rounded-md border border-border p-3 text-left hover:bg-accent transition-colors"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{s.project}</span>
              <StatusBadge status={s.status} />
            </div>
            {s.prompt && (
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {s.prompt.slice(0, 80)}
                {s.prompt.length > 80 ? '...' : ''}
              </p>
            )}
          </div>
          <span className="ml-2 text-xs text-muted-foreground whitespace-nowrap">
            {formatRelativeTime(s.created_at)}
          </span>
        </button>
      ))}
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ── New Session Dialog ──────────────────────────────────────────────

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
            {projects.map((wt) => {
              const active = (wt.sessions ?? []).filter((s) => ACTIVE_STATUSES.has(s.status))
              return (
                <option key={wt.name} value={wt.name}>
                  {wt.name} ({wt.branch}){active.length > 0 ? ` - ${active.length} active` : ''}
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

// ── Dashboard ───────────────────────────────────────────────────────

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectWithSessions[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessions, setActiveSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewSession, setShowNewSession] = useState(false)
  const [tab, setTab] = useState<'active' | 'history'>('active')

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 5000)
    return () => clearInterval(interval)
  }, [])

  async function loadData() {
    try {
      const [wtRes, sessRes, activeRes] = await Promise.all([
        fetch('/api/projects'),
        fetch('/api/sessions'),
        fetch('/api/sessions/active'),
      ])
      if (wtRes.ok) {
        const data = (await wtRes.json()) as { projects?: ProjectWithSessions[] }
        setProjects(data.projects ?? [])
      }
      if (sessRes.ok) {
        const data = (await sessRes.json()) as { sessions?: SessionSummary[] }
        setSessions(data.sessions ?? [])
      }
      if (activeRes.ok) {
        const data = (await activeRes.json()) as { sessions?: SessionSummary[] }
        setActiveSessions(data.sessions ?? [])
      }
    } catch {
      // Silently handle fetch errors
    } finally {
      setLoading(false)
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

  function handleSelectSession(id: string) {
    ;(self as unknown as { location: { href: string } }).location.href = `/session/${id}`
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Duraclaw</h1>
          <Button onClick={() => setShowNewSession(true)}>New Session</Button>
        </div>
      </header>

      <div className="flex">
        {/* Main Content */}
        <main className="flex-1 p-6">
          {/* Project Grid */}
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Projects
            </h2>
            <ProjectGrid projects={projects} loading={loading} />
          </section>

          {/* Sessions */}
          <section>
            <div className="mb-3 flex items-center gap-4">
              <button
                type="button"
                onClick={() => setTab('active')}
                className={cn(
                  'text-sm font-semibold uppercase tracking-wider',
                  tab === 'active'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Active ({activeSessions.length})
              </button>
              <button
                type="button"
                onClick={() => setTab('history')}
                className={cn(
                  'text-sm font-semibold uppercase tracking-wider',
                  tab === 'history'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                History
              </button>
            </div>

            {tab === 'active' ? (
              <SessionList
                sessions={activeSessions}
                title="active sessions"
                onSelect={handleSelectSession}
              />
            ) : (
              <SessionList
                sessions={sessions}
                title="sessions"
                onSelect={handleSelectSession}
              />
            )}
          </section>
        </main>
      </div>

      <NewSessionDialog
        open={showNewSession}
        onClose={() => setShowNewSession(false)}
        projects={projects}
        onSubmit={handleNewSession}
      />
    </div>
  )
}
