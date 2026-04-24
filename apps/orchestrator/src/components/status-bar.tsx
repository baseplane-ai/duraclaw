/**
 * StatusBar — VS Code-style fixed-bottom status bar showing session state.
 * Reads the active session's D1-mirrored row via `useSession` and the
 * transient WS readyState via `useSessionLocalState`. `sessionId` is a prop
 * from the parent route; when null, the bar renders nothing.
 */

import type { ProjectInfo } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { GitBranchIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ChainStatusItem } from '~/components/chain-status-item'
import { projectsCollection } from '~/db/projects-collection'
import { useSessionLocalState } from '~/db/session-local-collection'
import { useDerivedStatus } from '~/hooks/use-derived-status'
import { useSession } from '~/hooks/use-sessions-collection'
import { deriveDisplayStateFromStatus } from '~/lib/display-state'
import { parseJsonField } from '~/lib/json'
import type { KataSessionState, PrInfo, SessionStatus } from '~/lib/types'
import { cn } from '~/lib/utils'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'

function WsDot({ readyState }: { readyState: number }) {
  // Any non-OPEN state (CONNECTING/CLOSING/CLOSED) is surfaced as yellow —
  // partysocket auto-reconnects, so a CLOSED state is transient and
  // functionally the same as CONNECTING from the user's perspective. The
  // dot is the only signal the UI shows for connection health; the status
  // label stays anchored to the session's actual status (running / idle /
  // waiting_gate), not the WS state.
  return (
    <span
      className={cn('size-2 rounded-full', readyState === 1 ? 'bg-green-500' : 'bg-yellow-500')}
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
  // Spec #37 P2b: read the D1-mirrored row through `useSession` and the
  // transient WS readyState through `useSessionLocalState`. Status is the
  // `status` column (DO-authoritative via messagesCollection fold).
  const session = useSession(sessionId)
  const local = useSessionLocalState(sessionId)
  // Must be called unconditionally (before any early return) to preserve
  // hook order across the `if (!sessionId) return null` guard below.
  const worktreeInfoFromProjects = useWorktreeInfoFromProjects(session?.project ?? '')

  const readyState = local?.wsReadyState ?? 3

  const status = useDerivedStatus(sessionId) ?? (session?.status as SessionStatus | undefined)

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
  // DO-side `syncWorktreeInfoToD1` is defined but unwired (see
  // session-do.ts:2352), so `worktreeInfoJson` is always null today. Fall
  // back to deriving the branch/PR segment from `projectsCollection` —
  // which is synced from the gateway with live git state — keyed by the
  // session's project name. Restores the pre-spec-#37 branch + PR display
  // in the status bar until the DO-side writer lands.
  const worktreeInfoFromDo = parseJsonField<WorktreeInfo>(session?.worktreeInfoJson ?? null)
  const worktreeInfo = worktreeInfoFromDo ?? worktreeInfoFromProjects

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
        <WsDot readyState={readyState} />
        <span className="text-foreground">{display.label}</span>
        <span className="truncate text-muted-foreground">{project || '--'}</span>
      </div>
      {worktreeInfo && <WorktreeStatusItem info={worktreeInfo} />}
      <span className="truncate text-muted-foreground">{model || '--'}</span>

      {/* Row 2 (wraps on mobile): ctx + kata */}
      {contextUsage && <ContextBar contextUsage={contextUsage} />}
      {kataState && session?.kataIssue != null ? (
        <ChainStatusItem
          kataState={kataState}
          kataIssue={session.kataIssue}
          sessionId={sessionId}
        />
      ) : (
        kataState && <KataStatusItem kataState={kataState} />
      )}
    </div>
  )
}
