import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { Badge } from '~/components/ui/badge'
import { ScrollArea } from '~/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { useSession } from '~/lib/auth-client'
import {
  type CurrentDeploy,
  type DeployState,
  type DeployStatus,
  type LogLevel,
  PHASE_LABEL,
  PHASE_ORDER,
  type PhaseStatusKind,
  type WorkerStatusKind,
} from '~/lib/deploy-state-types'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/_authenticated/deploys')({
  component: DeploysPage,
})

const POLL_MS = 1000

// Repo selector — extensible. Gateway resolves the state file per repo:
//   DEPLOY_STATE_PATH_<UPPER> env var, else /data/projects/<id>-infra/.deploy-state.json
const REPOS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'baseplane', label: 'Baseplane' },
  { id: 'duraclaw', label: 'Duraclaw' },
]

const REPO_STORAGE_KEY = 'duraclaw.deploys.repo'

function phaseTone(status: PhaseStatusKind): string {
  switch (status) {
    case 'running':
      return 'bg-blue-500/15 text-blue-600 border-blue-500/30'
    case 'done':
      return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30'
    case 'skipped':
      return 'bg-muted text-muted-foreground border-border'
    default:
      return 'bg-muted/40 text-muted-foreground border-border'
  }
}

function workerTone(status: WorkerStatusKind): string {
  switch (status) {
    case 'deploying':
      return 'bg-blue-500/15 text-blue-600 border-blue-500/30'
    case 'deployed':
      return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
    case 'failed':
      return 'bg-destructive/15 text-destructive border-destructive/30'
    case 'skipped':
      return 'bg-muted text-muted-foreground border-border'
    default:
      return 'bg-muted/40 text-muted-foreground border-border'
  }
}

function deployTone(status: DeployStatus): string {
  if (status === 'done') return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
  if (status === 'failed') return 'bg-destructive/15 text-destructive border-destructive/30'
  if (status === 'idle') return 'bg-muted text-muted-foreground border-border'
  return 'bg-blue-500/15 text-blue-600 border-blue-500/30'
}

function logTone(level: LogLevel): string {
  if (level === 'error') return 'text-destructive'
  if (level === 'warn') return 'text-amber-600'
  return 'text-muted-foreground'
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString()
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function DeploysPage() {
  const { data: session, isPending } = useSession()
  const isAdmin = session?.user?.role === 'admin'

  if (isPending) {
    return (
      <>
        <Header fixed>
          <h1 className="text-lg font-semibold">Deploys</h1>
        </Header>
        <Main>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Main>
      </>
    )
  }

  if (!isAdmin) {
    return (
      <>
        <Header fixed>
          <h1 className="text-lg font-semibold">Deploys</h1>
        </Header>
        <Main>
          <p className="text-sm text-muted-foreground">Admin access required.</p>
        </Main>
      </>
    )
  }

  return <DeploysView />
}

function DeploysView() {
  const [repo, setRepo] = useState<string>(() => {
    if (typeof window === 'undefined') return REPOS[0].id
    const saved = window.localStorage.getItem(REPO_STORAGE_KEY)
    return saved && REPOS.some((r) => r.id === saved) ? saved : REPOS[0].id
  })
  const [state, setState] = useState<DeployState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const logTailRef = useRef<HTMLDivElement | null>(null)

  // Persist repo selection across reloads.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(REPO_STORAGE_KEY, repo)
  }, [repo])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        // Fetch the shared state file once — repo filtering happens client-side.
        const resp = await fetch('/api/deploys/state', {
          credentials: 'include',
        })
        if (!resp.ok) {
          const body = await resp.text().catch(() => '')
          if (!cancelled) setError(`HTTP ${resp.status}: ${body || resp.statusText}`)
          return
        }
        const data = (await resp.json()) as DeployState
        if (cancelled) return
        setState(data)
        setError(null)
        setLastFetchedAt(Date.now())
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }

    void load()
    const handle = window.setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [])

  // Client-side filter: isolate current deploy and queue by selected repo.
  // History entries lack worktree_name so they stay unfiltered (shared pipeline).
  const filtered = useMemo(() => {
    if (!state) return null
    const repoMatch = (wt: string | null | undefined) => !wt || wt === repo
    const currentMatch = repoMatch(state.current.worktree_name)
    return {
      ...state,
      current: currentMatch
        ? state.current
        : ({
            ...state.current,
            status: 'idle' as const,
            logs: [],
            phases: {},
            workers: [],
          } satisfies CurrentDeploy),
      queue: state.queue.filter((q) => {
        if (q.worktree_path) return q.worktree_path.includes(`/${repo}`)
        return true
      }),
    }
  }, [state, repo])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when log count changes to stick to tail
  useEffect(() => {
    const el = logTailRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [filtered?.current.logs.length])

  return (
    <>
      <Header fixed>
        <h1 className="text-lg font-semibold">Deploys</h1>
        <Tabs value={repo} onValueChange={setRepo} className="ml-4">
          <TabsList className="h-8">
            {REPOS.map((r) => (
              <TabsTrigger key={r.id} value={r.id} className="text-xs">
                {r.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="ml-auto text-xs text-muted-foreground">
          {lastFetchedAt
            ? `Updated ${new Date(lastFetchedAt).toLocaleTimeString()}`
            : 'Connecting…'}
        </span>
      </Header>

      <Main>
        <div className="space-y-2">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {filtered && (
            <>
              <CurrentDeploySection state={filtered} />
              <PhasesSection state={filtered} />
              <WorkersSection state={filtered} />
              <LogsSection state={filtered} logTailRef={logTailRef} />
              {filtered.queue.length > 0 && <QueueSection state={filtered} />}
              <HistorySection state={filtered} />
            </>
          )}

          {!filtered && !error && (
            <p className="text-sm text-muted-foreground">Loading deploy state…</p>
          )}
        </div>
      </Main>
    </>
  )
}

/** Compact section wrapper — replaces shadcn Card to kill the default p-6. */
function Section({
  title,
  actions,
  children,
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-md border bg-card">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {actions}
      </header>
      <div className="p-2">{children}</div>
    </section>
  )
}

function CurrentDeploySection({ state }: { state: DeployState }) {
  const { current } = state
  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
        <Badge variant="outline" className={cn('shrink-0 capitalize', deployTone(current.status))}>
          {current.status.replace(/_/g, ' ')}
        </Badge>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {current.commit_message || '—'}
        </p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs">
        <InlineField label="env" value={current.environment || '—'} />
        <InlineField label="branch" value={current.branch || '—'} />
        <InlineField
          label="commit"
          value={current.commit_sha ? shortSha(current.commit_sha) : '—'}
          mono
        />
        <InlineField label="trigger" value={current.trigger || '—'} />
        <InlineField label="author" value={current.push_author || '—'} />
        <InlineField label="started" value={fmtTime(current.started_at) || '—'} />
        <InlineField label="finished" value={fmtTime(current.finished_at) || '—'} />
        {current.worktree_name && <InlineField label="worktree" value={current.worktree_name} />}
      </div>
      {current.error && (
        <div className="border-t px-3 py-1.5">
          <p className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive">
            {current.error}
          </p>
        </div>
      )}
    </section>
  )
}

function InlineField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn('truncate', mono && 'font-mono')}>{value}</span>
    </span>
  )
}

function PhasesSection({ state }: { state: DeployState }) {
  return (
    <Section title="Phases">
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        {PHASE_ORDER.map((key) => {
          const phase = state.current.phases[key]
          const status = phase?.status ?? 'pending'
          return (
            <div
              key={key}
              className={cn(
                'rounded border px-2 py-1 text-[11px] leading-tight',
                phaseTone(status as PhaseStatusKind),
              )}
            >
              <p className="font-medium">{PHASE_LABEL[key] ?? key}</p>
              <p className="capitalize opacity-80">{(status as string).replace(/_/g, ' ')}</p>
              {phase?.error && (
                <p className="mt-0.5 truncate font-mono text-[10px]" title={phase.error}>
                  {phase.error}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function WorkersSection({ state }: { state: DeployState }) {
  const workers = state.current.workers
  return (
    <Section title={`Workers (${workers.length})`}>
      {workers.length === 0 ? (
        <p className="px-1 py-0.5 text-xs text-muted-foreground">No workers in this deploy.</p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {workers.map((w) => (
            <div
              key={w.name}
              className={cn(
                'rounded border px-2 py-1 text-[11px] leading-tight',
                workerTone(w.status),
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium" title={w.name}>
                  {w.name}
                </p>
                {w.retries > 0 && (
                  <span className="shrink-0 text-[10px] opacity-70">×{w.retries}</span>
                )}
              </div>
              <p className="capitalize opacity-80">
                {w.status}
                {w.health ? ` · ${w.health.healthy ? 'ok' : 'unhealthy'}` : ''}
                {w.health?.statusCode != null ? ` (${w.health.statusCode})` : ''}
              </p>
              {w.error && (
                <p className="mt-0.5 truncate font-mono text-[10px]" title={w.error}>
                  {w.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function LogsSection({
  state,
  logTailRef,
}: {
  state: DeployState
  logTailRef: React.RefObject<HTMLDivElement | null>
}) {
  const logs = state.current.logs
  return (
    <Section title={`Logs (${logs.length})`}>
      <ScrollArea className="h-60 rounded border bg-muted/30">
        <div ref={logTailRef} className="h-60 overflow-auto p-2 font-mono text-[11px] leading-4">
          {logs.length === 0 ? (
            <p className="text-muted-foreground">No logs yet.</p>
          ) : (
            logs.map((entry, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: log entries have no unique id; list is append-only and auto-scrolls
                key={i}
                className={cn('whitespace-pre-wrap break-words', logTone(entry.level))}
              >
                <span className="opacity-60">{fmtTime(entry.timestamp)}</span>{' '}
                <span className="uppercase opacity-70">{entry.level}</span> {entry.message}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </Section>
  )
}

function QueueSection({ state }: { state: DeployState }) {
  return (
    <Section title={`Queue (${state.queue.length})`}>
      <div className="space-y-1 text-xs">
        {state.queue.map((q) => (
          <div
            key={`${q.commit_sha}-${q.queued_at}`}
            className="flex items-center justify-between gap-2 rounded border px-2 py-1"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate">{q.commit_message || '—'}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {q.environment} · {q.branch} · {shortSha(q.commit_sha)} · {q.push_author}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {fmtTime(q.queued_at)}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function HistorySection({ state }: { state: DeployState }) {
  const recent = state.history.slice(-8).reverse()
  return (
    <Section title="Recent History">
      {recent.length === 0 ? (
        <p className="px-1 py-0.5 text-xs text-muted-foreground">No prior deploys recorded.</p>
      ) : (
        <div className="space-y-1 text-xs">
          {recent.map((h) => (
            <div
              key={`${h.commit_sha}-${h.started_at}`}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      'shrink-0 px-1.5 py-0 text-[10px] capitalize leading-4',
                      h.status === 'done'
                        ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                        : 'bg-destructive/15 text-destructive border-destructive/30',
                    )}
                  >
                    {h.status}
                  </Badge>
                  <p className="truncate">{h.commit_message || '—'}</p>
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {h.environment} · {h.branch} · {shortSha(h.commit_sha)} · {h.push_author}
                </p>
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                <div>{fmtTime(h.finished_at)}</div>
                <div>
                  {h.workers_deployed}/{h.workers_total} · {fmtDuration(h.duration_seconds)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}
