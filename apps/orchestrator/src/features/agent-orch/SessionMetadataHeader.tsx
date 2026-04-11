/**
 * SessionMetadataHeader — Status strip above chat thread.
 */

import { useEffect, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import type { SessionState } from '~/lib/types'
import { cn } from '~/lib/utils'

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  idle: 'outline',
  running: 'default',
  waiting_gate: 'secondary',
  completed: 'default',
  failed: 'destructive',
  aborted: 'destructive',
}

interface SessionMetadataHeaderProps {
  state: SessionState | null
  onStop: (reason: string) => void
  sessionResult?: { total_cost_usd: number; duration_ms: number } | null
  wsReadyState?: number
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes === 0) return `${remainingSeconds}s`
  return `${minutes}m ${remainingSeconds}s`
}

export function SessionMetadataHeader({
  state,
  onStop,
  sessionResult,
  wsReadyState,
}: SessionMetadataHeaderProps) {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (state?.status !== 'running' || !state?.started_at) {
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
  }, [state?.status, state?.started_at])

  if (!state) return null

  const status = state.status
  const canStop = status === 'running' || status === 'waiting_gate'

  return (
    <div
      className="flex items-center gap-4 border-b px-4 py-2 text-sm"
      data-testid="session-metadata-header"
    >
      <span
        className={cn(
          'size-2 rounded-full',
          wsReadyState === 1 ? 'bg-green-500' : wsReadyState === 0 ? 'bg-yellow-500' : 'bg-red-500',
        )}
        title={
          wsReadyState === 1 ? 'Connected' : wsReadyState === 0 ? 'Connecting...' : 'Disconnected'
        }
        data-testid="ws-status-dot"
      />
      <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>{status}</Badge>
      <span className="text-muted-foreground">
        <span className="font-mono">{state.project || '--'}</span>
      </span>
      <span className="text-muted-foreground">
        <span className="font-mono">{state.model || '--'}</span>
      </span>
      <span className="text-muted-foreground">{state.num_turns} turns</span>

      {status === 'running' && state.started_at && elapsedMs > 0 && (
        <span className="text-muted-foreground" data-testid="elapsed-timer">
          {formatDuration(elapsedMs)}
        </span>
      )}

      {sessionResult?.total_cost_usd != null && (
        <span className="text-muted-foreground">${sessionResult.total_cost_usd.toFixed(4)}</span>
      )}
      {sessionResult?.duration_ms != null && (
        <span className="text-muted-foreground">{formatDuration(sessionResult.duration_ms)}</span>
      )}

      {state.error && <span className="text-destructive">Error: {state.error}</span>}

      <div className="ml-auto">
        {canStop && (
          <Button
            variant="destructive"
            size="sm"
            aria-label="Stop session"
            onClick={() => onStop('Stopped by user')}
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  )
}
