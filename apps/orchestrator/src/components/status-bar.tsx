/**
 * StatusBar — VS Code-style fixed-bottom status bar showing session state.
 * Status is DO-authoritative via `useSessionStatus` (extracted from WS
 * frames), with D1 `session?.status` as cold-start fallback only.
 */

import type { ProjectInfo } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { GitBranchIcon } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArcStatusItem } from '~/components/arc-status-item'
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover'
import { projectsCollection } from '~/db/projects-collection'
import { useSessionLocalState, useSessionStatus } from '~/db/session-local-collection'
import { useSession } from '~/hooks/use-sessions-collection'
import { deriveDisplayStateFromStatus } from '~/lib/display-state'
import { parseJsonField } from '~/lib/json'
import type { KataSessionState, PrInfo, SessionStatus } from '~/lib/types'
import { cn } from '~/lib/utils'
import { getWsDebugInfo, subscribeWsDebug, type WsDebugInfo } from '~/lib/ws-debug'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'

function useWsDebugInfo(channel: string | null): WsDebugInfo | null {
  return useSyncExternalStore(
    (cb) => (channel ? subscribeWsDebug(channel, cb) : () => {}),
    () => (channel ? getWsDebugInfo(channel) : null),
    () => null,
  )
}

function readyStateLabel(rs: number): string {
  switch (rs) {
    case 0:
      return 'CONNECTING (0)'
    case 1:
      return 'OPEN (1)'
    case 2:
      return 'CLOSING (2)'
    case 3:
      return 'CLOSED (3)'
    default:
      return `unknown (${rs})`
  }
}

function formatAge(ts: number | null, now: number): string {
  if (!ts) return '—'
  const ms = Math.max(0, now - ts)
  if (ms < 1000) return `${ms}ms ago`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  return `${m}m ago`
}

function WsDebugRow({
  label,
  channel,
  readyState,
}: {
  label: string
  channel: string
  readyState?: number
}) {
  const info = useWsDebugInfo(channel)
  // Re-render every second so "Xs ago" stays fresh while the popover is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="space-y-0.5 border-b pb-2 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-2 font-medium">
        <span>{label}</span>
        <span className="text-muted-foreground">{channel}</span>
      </div>
      {readyState !== undefined && (
        <div>
          <span className="text-muted-foreground">readyState: </span>
          {readyStateLabel(readyState)}
        </div>
      )}
      {info ? (
        <>
          {info.url && (
            <div className="break-all">
              <span className="text-muted-foreground">url: </span>
              {info.url}
            </div>
          )}
          <div>
            <span className="text-muted-foreground">last open: </span>
            {formatAge(info.lastOpenAt, now)}
            <span className="text-muted-foreground"> · count: </span>
            {info.openCount}
          </div>
          <div>
            <span className="text-muted-foreground">last close: </span>
            {info.lastCloseAt ? (
              <>
                code={info.lastCloseCode ?? '?'} reason=
                {JSON.stringify(info.lastCloseReason ?? '')} wasClean=
                {String(info.lastCloseWasClean ?? '?')} uptime=
                {info.lastCloseUptimeMs == null ? 'never-opened' : `${info.lastCloseUptimeMs}ms`} ·{' '}
                {formatAge(info.lastCloseAt, now)}
              </>
            ) : (
              '—'
            )}
            <span className="text-muted-foreground"> · count: </span>
            {info.closeCount}
          </div>
          <div>
            <span className="text-muted-foreground">last error: </span>
            {info.lastErrorAt ? formatAge(info.lastErrorAt, now) : '—'}
            <span className="text-muted-foreground"> · count: </span>
            {info.errorCount}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground">no events captured yet</div>
      )}
    </div>
  )
}

function WsDot({ readyState, sessionId }: { readyState: number; sessionId: string | null }) {
  // Any non-OPEN state (CONNECTING/CLOSING/CLOSED) is surfaced as yellow —
  // partysocket auto-reconnects, so a CLOSED state is transient and
  // functionally the same as CONNECTING from the user's perspective. The
  // dot is the only signal the UI shows for connection health; the status
  // label stays anchored to the session's actual status (running / idle /
  // waiting_gate), not the WS state.
  //
  // Tap-revealable diagnostic panel surfaces last close code / reason /
  // uptime, so mobile users can self-diagnose "yellow dot that won't go
  // green" without remote-debugging — `attachWsDebug` writes the info to
  // a module-level store; this popover reads it.
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Hit target is the full button (min-size 32×32 ≈ touch min); the
            visual dot stays at size-2 (8px) inside via the inner span so the
            status bar density isn't disturbed. Negative -mx keeps the
            extra padding from pushing neighbours sideways visually. */}
        <button
          type="button"
          className="-mx-2 inline-flex size-8 cursor-pointer items-center justify-center rounded ring-offset-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={readyState === 1 ? 'WS connected' : 'WS reconnecting — tap for details'}
          title={readyState === 1 ? 'Connected' : 'Reconnecting…'}
          data-testid="ws-dot"
        >
          <span
            className={cn(
              'size-2 rounded-full',
              readyState === 1 ? 'bg-green-500' : 'bg-yellow-500',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 space-y-2 font-mono text-[11px] leading-tight"
      >
        {sessionId ? (
          <WsDebugRow label="session" channel={`agent:${sessionId}`} readyState={readyState} />
        ) : null}
        <WsDebugRow label="user-stream" channel="user-stream" />
      </PopoverContent>
    </Popover>
  )
}

function ContextBar({ contextUsage }: { contextUsage: ContextUsage }) {
  if (contextUsage.maxTokens <= 0) return null
  return (
    <div
      className="flex items-center gap-1"
      title={`${contextUsage.totalTokens.toLocaleString()} / ${contextUsage.maxTokens.toLocaleString()} tokens (${Math.round(contextUsage.percentage)}%)`}
    >
      <div className="h-2 w-12 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            contextUsage.percentage >= 90
              ? 'bg-red-500'
              : contextUsage.percentage >= 70
                ? 'bg-yellow-500'
                : 'bg-green-500',
          )}
          style={{ width: `${Math.min(contextUsage.percentage, 100)}%` }}
        />
      </div>
      <span className="text-muted-foreground">{Math.round(contextUsage.percentage)}%</span>
    </div>
  )
}

function getBarClasses(status: string | undefined): string {
  if (!status) return 'bg-background border-t'
  switch (status) {
    // `pending` collapses into the RUNNING tint so the StatusBar shows
    // a single in-flight color for the whole turn. The inline
    // AwaitingBubble distinguishes the pre-first-token phase in-thread;
    // the chrome doesn't need a second violet flash that flickers off on
    // the first partial_assistant delta.
    case 'running':
    case 'pending':
      return 'bg-info/20 border-t border-info/50'
    case 'waiting_gate':
    case 'waiting_input':
    case 'waiting_permission':
      return 'bg-warning/20 border-t border-warning/50'
    // Spec #80 B7: `error` = watchdog terminal state. Red tint mirrors
    // the display-state color token.
    case 'error':
      return 'bg-red-500/20 border-t border-red-500/50'
    default:
      return 'bg-background border-t'
  }
}

function PrStatusBadge({ pr }: { pr: PrInfo }) {
  const stateLabel =
    pr.state === 'MERGED'
      ? 'merged'
      : pr.state === 'CLOSED'
        ? 'closed'
        : pr.draft
          ? 'draft'
          : 'open'

  const stateColor =
    pr.state === 'MERGED'
      ? 'text-purple-400'
      : pr.state === 'CLOSED'
        ? 'text-red-400'
        : pr.draft
          ? 'text-muted-foreground'
          : 'text-green-400'

  let checksLabel = ''
  if (pr.checks) {
    if (pr.checks.fail > 0) checksLabel = ` \u26A0 ${pr.checks.fail} failing`
    else if (pr.checks.pending > 0) checksLabel = ` \u22EF pending`
    else checksLabel = ` \u2713 ${pr.checks.pass}/${pr.checks.total}`
  }

  return (
    <span className={cn('whitespace-nowrap', stateColor)} title={`PR #${pr.number} ${stateLabel}`}>
      PR#{pr.number} {stateLabel}
      {checksLabel}
    </span>
  )
}

function WorktreeStatusItem({ info }: { info: WorktreeInfo }) {
  return (
    <div
      className="flex items-center gap-1 text-muted-foreground"
      title={`${info.name} — ${info.branch}`}
    >
      <GitBranchIcon className="size-3 shrink-0" />
      <span className="truncate">{info.branch}</span>
      {info.dirty && <span className="shrink-0 text-yellow-400">{'●'}</span>}
      {info.ahead > 0 && (
        <span className="shrink-0">
          {info.ahead}
          {'▲'}
        </span>
      )}
      {info.behind > 0 && (
        <span className="shrink-0">
          {info.behind}
          {'▼'}
        </span>
      )}
      {info.pr && <PrStatusBadge pr={info.pr} />}
    </div>
  )
}

function KataStatusItem({ kataState }: { kataState: KataSessionState }) {
  const [showPopover, setShowPopover] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => setShowPopover(!showPopover)}
      >
        kata: {kataState.currentMode}/{kataState.currentPhase || '\u2014'}
      </button>
      {showPopover && (
        <div className="absolute bottom-full left-0 mb-1 w-64 rounded border bg-popover p-3 text-popover-foreground shadow-md text-xs">
          <div className="flex flex-col gap-1.5">
            <div>
              <span className="text-muted-foreground">Mode:</span> {kataState.currentMode}
            </div>
            <div>
              <span className="text-muted-foreground">Phase:</span>{' '}
              {kataState.currentPhase || '\u2014'}
            </div>
            {kataState.issueNumber && (
              <div>
                <span className="text-muted-foreground">Issue:</span> #{kataState.issueNumber}
              </div>
            )}
            {kataState.sessionType && (
              <div>
                <span className="text-muted-foreground">Type:</span> {kataState.sessionType}
              </div>
            )}
            {kataState.completedPhases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {kataState.completedPhases.map((p) => (
                  <span key={p} className="rounded bg-muted px-1.5 py-0.5">
                    {p}
                  </span>
                ))}
              </div>
            )}
            {kataState.phases.length > 0 && (
              <div className="mt-1">
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{
                      width: `${(kataState.completedPhases.length / kataState.phases.length) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function useWorktreeInfoFromProjects(projectName: string): WorktreeInfo | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projects } = useLiveQuery((q) => q.from({ p: projectsCollection as any }))
  return useMemo(() => {
    if (!projectName || !projects || projects.length === 0) return null
    const match = (projects as unknown as ProjectInfo[]).find((p) => p.name === projectName)
    if (!match) return null
    return {
      name: match.name,
      branch: match.branch,
      dirty: match.dirty,
      ahead: match.ahead ?? 0,
      behind: match.behind ?? 0,
      pr: match.pr ?? null,
    }
  }, [projects, projectName])
}

export function StatusBar({ sessionId }: { sessionId: string | null }) {
  // DO-authoritative status from WS frames; D1 row as cold-start fallback.
  const session = useSession(sessionId)
  const local = useSessionLocalState(sessionId)
  // Must be called unconditionally (before any early return) to preserve
  // hook order across the `if (!sessionId) return null` guard below.
  const worktreeInfoFromProjects = useWorktreeInfoFromProjects(session?.project ?? '')

  const readyState = local?.wsReadyState ?? 3

  const status = useSessionStatus(sessionId) ?? (session?.status as SessionStatus | undefined)

  if (!sessionId) return null
  const statusResolved: SessionStatus = status ?? 'idle'
  // Force `wsReadyState=1` when deriving the display label so it stays
  // anchored to the session's actual status (Running / Idle / Needs
  // Attention) regardless of WS health. Connection health is communicated
  // by `WsDot`'s color — the label shouldn't flicker to "Reconnecting…"
  // every time partysocket hiccups.
  const display = deriveDisplayStateFromStatus(statusResolved, 1)
  const project = session?.project ?? ''
  const model = session?.model ?? null
  const contextUsage = parseJsonField<ContextUsage>(session?.contextUsageJson ?? null)
  const kataState = parseJsonField<KataSessionState>(session?.kataStateJson ?? null)
  // GH#115 P1.4: the legacy `worktreeInfoJson` column was dropped (the
  // DO-side writer was never wired). Branch/PR segments are derived from
  // `projectsCollection`, which is synced from the gateway with live
  // git state and keyed by the session's project name.
  const worktreeInfo = worktreeInfoFromProjects

  return (
    <div
      className={cn(
        'flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1 font-mono text-xs',
        getBarClasses(statusResolved),
      )}
      data-testid="status-bar"
      data-display-status={display.status}
    >
      {/* Row 1: status + project + branch + model.
          `display.label` routes through `deriveDisplayStateFromStatus`, so
          it flips to 'Reconnecting…' whenever `readyState !== 1` — keeping
          the label in sync with the red/yellow/green dot instead of
          showing the stale server status (e.g. 'idle') next to a red dot. */}
      <div className="flex min-w-0 items-center gap-2">
        <WsDot readyState={readyState} sessionId={sessionId} />
        <span className="text-foreground">{display.label}</span>
        <span className="truncate text-muted-foreground">{project || '--'}</span>
        {/* Session title — migrated from tab bar as part of the dense-tab
            redesign. Tabs now carry only project abbrev+worktreeN; the full
            title lives here so the active session is always identifiable
            without hovering a tab. */}
        {session?.title && (
          <span className="truncate text-foreground/90" title={session.title}>
            · {session.title}
          </span>
        )}
      </div>
      <span className="truncate text-muted-foreground">{model || '--'}</span>
      {session?.identityName && (
        <span
          className="truncate text-muted-foreground"
          title={`Anthropic identity (runner HOME): ${session.identityName}`}
          data-testid="status-bar-identity"
        >
          · @{session.identityName}
        </span>
      )}
      {worktreeInfo && <WorktreeStatusItem info={worktreeInfo} />}

      {/* Row 2 (wraps on mobile): ctx + kata */}
      {contextUsage && <ContextBar contextUsage={contextUsage} />}
      {kataState && session?.kataIssue != null ? (
        <ArcStatusItem kataState={kataState} kataIssue={session.kataIssue} sessionId={sessionId} />
      ) : (
        kataState && <KataStatusItem kataState={kataState} />
      )}
    </div>
  )
}
