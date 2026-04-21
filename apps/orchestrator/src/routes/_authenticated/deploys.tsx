import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { ScrollArea } from '~/components/ui/scroll-area'
import { useSession } from '~/lib/auth-client'
import {
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
  const [state, setState] = useState<DeployState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const logTailRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const resp = await fetch('/api/deploys/state', { credentials: 'include' })
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when log count changes to stick to tail
  useEffect(() => {
    const el = logTailRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [state?.current.logs.length])

  return (
    <>
      <Header fixed>
        <h1 className="text-lg font-semibold">Deploys</h1>
        <span className="ml-auto text-xs text-muted-foreground">
          {lastFetchedAt
            ? `Updated ${new Date(lastFetchedAt).toLocaleTimeString()}`
            : 'Connecting…'}
        </span>
      </Header>

      <Main>
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {state && (
            <>
              <CurrentDeployCard state={state} />
              <PhasesCard state={state} />
              <WorkersCard state={state} />
              <LogsCard state={state} logTailRef={logTailRef} />
              {state.queue.length > 0 && <QueueCard state={state} />}
              <HistoryCard state={state} />
            </>
          )}

          {!state && !error && (
            <p className="text-sm text-muted-foreground">Loading deploy state…</p>
          )}
        </div>
      </Main>
    </>
  )
}

function CurrentDeployCard({ state }: { state: DeployState }) {
  const { current } = state
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate">Current Deploy</CardTitle>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {current.commit_message || '—'}
          </p>
        </div>
        <Badge variant="outline" className={cn('shrink-0 capitalize', deployTone(current.status))}>
          {current.status.replace(/_/g, ' ')}
        </Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Field label="Environment" value={current.environment || '—'} />
        <Field label="Branch" value={current.branch || '—'} />
        <Field
          label="Commit"
          value={current.commit_sha ? shortSha(current.commit_sha) : '—'}
          mono
        />
        <Field label="Trigger" value={current.trigger || '—'} />
        <Field label="Author" value={current.push_author || '—'} />
        <Field label="Started" value={fmtTime(current.started_at)} />
        <Field label="Finished" value={fmtTime(current.finished_at) || '—'} />
        <Field label="Worktree" value={current.worktree_name || '—'} />
        {current.error && (
          <div className="col-span-full">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Error
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-destructive">
              {current.error}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('truncate', mono && 'font-mono')}>{value}</p>
    </div>
  )
}

function PhasesCard({ state }: { state: DeployState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Phases</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {PHASE_ORDER.map((key) => {
            const phase = state.current.phases[key]
            const status = phase?.status ?? 'pending'
            return (
              <div
                key={key}
                className={cn(
                  'rounded-md border px-3 py-2 text-xs',
                  phaseTone(status as PhaseStatusKind),
                )}
              >
                <p className="font-medium">{PHASE_LABEL[key] ?? key}</p>
                <p className="mt-0.5 capitalize opacity-80">
                  {(status as string).replace(/_/g, ' ')}
                </p>
                {phase?.error && (
                  <p className="mt-1 truncate font-mono text-[10px]" title={phase.error}>
                    {phase.error}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function WorkersCard({ state }: { state: DeployState }) {
  const workers = state.current.workers
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workers</CardTitle>
      </CardHeader>
      <CardContent>
        {workers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workers in this deploy.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {workers.map((w) => (
              <div
                key={w.name}
                className={cn('rounded-md border px-3 py-2 text-xs', workerTone(w.status))}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium" title={w.name}>
                    {w.name}
                  </p>
                  {w.retries > 0 && (
                    <span className="shrink-0 text-[10px] opacity-70">×{w.retries}</span>
                  )}
                </div>
                <p className="mt-0.5 capitalize opacity-80">{w.status}</p>
                {w.health && (
                  <p className="mt-1 text-[10px] opacity-70">
                    {w.health.healthy ? 'healthy' : 'unhealthy'}
                    {w.health.statusCode != null ? ` (${w.health.statusCode})` : ''}
                  </p>
                )}
                {w.error && (
                  <p className="mt-1 truncate font-mono text-[10px]" title={w.error}>
                    {w.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function LogsCard({
  state,
  logTailRef,
}: {
  state: DeployState
  logTailRef: React.RefObject<HTMLDivElement | null>
}) {
  const logs = state.current.logs
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-72 rounded-md border bg-muted/30">
          <div ref={logTailRef} className="h-72 overflow-auto p-3 font-mono text-xs leading-5">
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
      </CardContent>
    </Card>
  )
}

function QueueCard({ state }: { state: DeployState }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Queue ({state.queue.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          {state.queue.map((q) => (
            <div
              key={`${q.commit_sha}-${q.queued_at}`}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate">{q.commit_message || '—'}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {q.environment} · {q.branch} · {shortSha(q.commit_sha)} · {q.push_author}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{fmtTime(q.queued_at)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function HistoryCard({ state }: { state: DeployState }) {
  const recent = state.history.slice(-8).reverse()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent History</CardTitle>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No prior deploys recorded.</p>
        ) : (
          <div className="space-y-1.5 text-sm">
            {recent.map((h) => (
              <div
                key={`${h.commit_sha}-${h.started_at}`}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        'shrink-0 capitalize',
                        h.status === 'done'
                          ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                          : 'bg-destructive/15 text-destructive border-destructive/30',
                      )}
                    >
                      {h.status}
                    </Badge>
                    <p className="truncate">{h.commit_message || '—'}</p>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {h.environment} · {h.branch} · {shortSha(h.commit_sha)} · {h.push_author}
                  </p>
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <div>{fmtTime(h.finished_at)}</div>
                  <div>
                    {h.workers_deployed}/{h.workers_total} · {fmtDuration(h.duration_seconds)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
