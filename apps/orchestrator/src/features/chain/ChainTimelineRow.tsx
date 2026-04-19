/**
 * ChainTimelineRow — one mode session in the chain timeline.
 *
 * P1 stub: status dot, mode badge, status label, relative timestamp.
 * Artifact chips are deferred to a follow-up unit that wires the
 * gateway project-browse glob.
 */

import type { SessionRecord } from '~/db/agent-sessions-collection'
import { Badge } from '~/components/ui/badge'
import { formatTimeAgo, StatusDot } from '~/features/agent-orch/session-utils'

interface ChainTimelineRowProps {
  session: SessionRecord
  active: boolean
  liveText?: string
}

function deriveStatusLabel(session: SessionRecord): string {
  // SessionRecord.status is typed as SessionStatus (the 5 live states) but
  // D1 rows can also carry terminal strings like 'completed' / 'crashed'
  // that predate or sidestep the narrow type. Widen to string for the
  // switch below.
  const s: string = session.status || 'idle'
  if (s === 'completed') return 'done'
  if (s === 'crashed') return 'crashed'
  if (s === 'running') return 'live'
  if (s.startsWith('waiting')) return 'waiting'
  return 'idle'
}

export function ChainTimelineRow({ session, active, liveText }: ChainTimelineRowProps) {
  const ts = session.lastActivity ?? session.createdAt
  const mode = session.kataMode ?? 'session'
  const statusLabel = deriveStatusLabel(session)

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border px-3 py-2 ${
        active ? 'border-primary/60 bg-muted/30' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-3">
        <StatusDot status={session.status || 'idle'} numTurns={session.numTurns ?? 0} />
        <Badge variant="outline" className="font-mono">
          {mode}
        </Badge>
        <span className="text-xs text-muted-foreground uppercase tracking-wide">
          {statusLabel}
        </span>
        <span className="text-xs text-muted-foreground">{formatTimeAgo(ts)}</span>
        <div className="ml-auto flex gap-1">
          {/* TODO P1.x: artifact chips (research doc, spec, PR) */}
        </div>
      </div>
      {active && liveText ? (
        <pre className="text-xs font-mono whitespace-pre-wrap opacity-70 max-h-48 overflow-hidden">
          {liveText}
        </pre>
      ) : null}
    </div>
  )
}
