/**
 * StatusBar — VS Code-style fixed-bottom status bar showing session state.
 * Reads from the Zustand status-bar store (populated by AgentDetailView).
 */

import { Square, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { KataSessionState, SessionState } from '~/lib/types'
import { cn } from '~/lib/utils'
import { type ContextUsage, useStatusBarStore } from '~/stores/status-bar'
import { Button } from './ui/button'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes === 0) return `${remainingSeconds}s`
  return `${minutes}m ${remainingSeconds}s`
}

function WsDot({ readyState }: { readyState: number }) {
  return (
    <span
      className={cn(
        'size-2 rounded-full',
        readyState === 1 ? 'bg-green-500' : readyState === 0 ? 'bg-yellow-500' : 'bg-red-500',
      )}
      title={readyState === 1 ? 'Connected' : readyState === 0 ? 'Connecting...' : 'Disconnected'}
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

function ElapsedTimer({ state }: { state: SessionState }) {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (state.status !== 'running' || !state.started_at) {
      setElapsedMs(0)
      return
    }
    const startTime = new Date(state.started_at).getTime()
    if (Number.isNaN(startTime)) return

    setElapsedMs(Date.now() - startTime)

    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startTime)
    }, 1000)
    return () => clearInterval(interval)
  }, [state.status, state.started_at])

  if (state.status !== 'running' || !state.started_at || elapsedMs <= 0) return null
  return <span className="text-muted-foreground">{formatDuration(elapsedMs)}</span>
}

function getBarClasses(status: string | undefined): string {
  if (!status) return 'bg-background border-t'
  switch (status) {
    case 'running':
      return 'bg-blue-950/50 border-t border-blue-800'
    case 'waiting_gate':
    case 'waiting_input':
    case 'waiting_permission':
      return 'bg-amber-950/50 border-t border-amber-800'
    case 'aborted':
      return 'bg-red-950/50 border-t border-red-800'
    default:
      return 'bg-background border-t'
  }
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

export function StatusBar() {
  const { state, wsReadyState, contextUsage, sessionResult, onStop, onInterrupt, kataState } =
    useStatusBarStore()

  const status = state?.status
  const canStop = status === 'running' || status === 'waiting_gate'

  if (!state) return null

  return (
    <div
      className={cn(
        'flex h-7 items-center justify-between px-2 font-mono text-xs',
        getBarClasses(status),
      )}
      data-testid="status-bar"
    >
      {/* Left section */}
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <WsDot readyState={wsReadyState} />
        <span className="text-foreground">{status}</span>
        <span className="text-muted-foreground">{state.project || '--'}</span>
        <span className="text-muted-foreground">{state.model || '--'}</span>
        <span className="text-muted-foreground">{state.num_turns} turns</span>
        {sessionResult?.total_cost_usd != null && (
          <span className="text-muted-foreground">${sessionResult.total_cost_usd.toFixed(4)}</span>
        )}
        {contextUsage && <ContextBar contextUsage={contextUsage} />}
        {kataState && <KataStatusItem kataState={kataState} />}
      </div>

      {/* Right section */}
      <div className="flex shrink-0 items-center gap-2">
        <ElapsedTimer state={state} />
        {sessionResult?.duration_ms != null && (
          <span className="text-muted-foreground">{formatDuration(sessionResult.duration_ms)}</span>
        )}
        {canStop && onInterrupt && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            aria-label="Interrupt session"
            onClick={onInterrupt}
          >
            <Zap className="h-3 w-3" />
          </Button>
        )}
        {canStop && onStop && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-red-400 hover:text-red-300"
            aria-label="Stop session"
            onClick={() => onStop('Stopped by user')}
          >
            <Square className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
