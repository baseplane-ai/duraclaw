/**
 * StatusBar — VS Code-style fixed-bottom status bar showing session state.
 * Reads the active session's live state via `useSessionLiveState` (thin
 * wrapper over `sessionLiveStateCollection`'s useLiveQuery). `sessionId` is
 * a prop from the parent route; when null, the bar renders nothing.
 */

import { GitBranchIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useDerivedStatus } from '~/hooks/use-derived-status'
import { useSessionLiveState } from '~/hooks/use-session-live-state'
import { deriveDisplayStateFromStatus } from '~/lib/display-state'
import type { KataSessionState, PrInfo, SessionStatus } from '~/lib/types'
import { cn } from '~/lib/utils'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes === 0) return `${remainingSeconds}s`
  return `${minutes}m ${remainingSeconds}s`
}

function WsDot({ readyState }: { readyState: number }) {
  // Any non-OPEN state (CONNECTING/CLOSING/CLOSED) is surfaced as yellow —
  // partysocket auto-reconnects, so a CLOSED state is transient and
  // functionally the same as CONNECTING from the user's perspective. The
  // dot is the only signal the UI shows for connection health; the status
  // label stays anchored to the session's actual status (running / idle /
  // waiting_gate), not the WS state.
  return (
    <span
      className={cn(
        'size-2 rounded-full',
        readyState === 1 ? 'bg-green-500' : 'bg-yellow-500',
      )}
      title={readyState === 1 ? 'Connected' : 'Reconnecting…'}
    />
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

function ElapsedTimer({
  status,
  startedAt,
}: {
  status: SessionStatus
  startedAt: string | null | undefined
}) {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (status !== 'running' || !startedAt) {
      setElapsedMs(0)
      return
    }
    const startTime = new Date(startedAt).getTime()
    if (Number.isNaN(startTime)) return

    setElapsedMs(Date.now() - startTime)

    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startTime)
    }, 1000)
    return () => clearInterval(interval)
  }, [status, startedAt])

  if (status !== 'running' || !startedAt || elapsedMs <= 0) return null
  return <span className="text-muted-foreground">{formatDuration(elapsedMs)}</span>
}

function getBarClasses(status: string | undefined): string {
  if (!status) return 'bg-background border-t'
  switch (status) {
    case 'running':
      return 'bg-info/20 border-t border-info/50'
    case 'waiting_gate':
    case 'waiting_input':
    case 'waiting_permission':
      return 'bg-warning/20 border-t border-warning/50'
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
          <div className="space-y-1.5">
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

export function StatusBar({ sessionId }: { sessionId: string | null }) {
  const live = useSessionLiveState(sessionId)
  // Spec-31 P5: status is derived client-side from messages; summary
  // columns (project / model / numTurns / totalCostUsd / durationMs)
  // come from the D1-mirrored SessionLiveState fields seeded by
  // SessionSummary, not the (now-deleted) full SessionState blob.
  const derivedStatus = useDerivedStatus(sessionId ?? '')

  if (!sessionId) return null
  const readyState = live.wsReadyState ?? 3
  // Force `wsReadyState=1` when deriving the display label so it stays
  // anchored to the session's actual status (Running / Idle / Needs
  // Attention) regardless of WS health. Connection health is communicated
  // by `WsDot`'s color — the label shouldn't flicker to "Reconnecting…"
  // every time partysocket hiccups.
  const display = deriveDisplayStateFromStatus(derivedStatus, 1)
  const status = derivedStatus
  const project = live.project ?? ''
  const model = live.model ?? null
  const numTurns = live.numTurns ?? 0
  const totalCostUsd = live.totalCostUsd ?? null
  const durationMs = live.durationMs ?? null

  return (
    <div
      className={cn(
        'flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-1 font-mono text-xs',
        getBarClasses(status),
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
        <WsDot readyState={readyState} />
        <span className="text-foreground">{display.label}</span>
        <span className="truncate text-muted-foreground">{project || '--'}</span>
      </div>
      {live.worktreeInfo && <WorktreeStatusItem info={live.worktreeInfo} />}
      <span className="truncate text-muted-foreground">{model || '--'}</span>

      {/* Row 2 (wraps on mobile): turns + cost + ctx + kata + timer + actions */}
      <span className="text-muted-foreground">{numTurns} turns</span>
      {totalCostUsd != null && (
        <span className="text-muted-foreground">${totalCostUsd.toFixed(4)}</span>
      )}
      {live.contextUsage && <ContextBar contextUsage={live.contextUsage} />}
      {live.kataState && <KataStatusItem kataState={live.kataState} />}

      {/* Right-aligned timer — action buttons moved to the composer footer */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ElapsedTimer status={status} startedAt={live.lastActivity ?? null} />
        {durationMs != null && (
          <span className="text-muted-foreground">{formatDuration(durationMs)}</span>
        )}
      </div>
    </div>
  )
}
