/**
 * ChainTimelineRow — one mode session in the chain timeline.
 *
 * P3 U3: optional PR artifact chip rendered when `prNumber` is set AND
 * this row is the implementation session (PRs are produced by the impl
 * mode). Kept intentionally as a non-anchor badge for now — the external
 * GitHub URL isn't resolvable client-side without plumbing `GITHUB_REPO`
 * through another endpoint. Linking is deferred.
 */

import { Badge } from '~/components/ui/badge'
import type { SessionRecord } from '~/db/session-record'
import { formatTimeAgo, StatusDot } from '~/features/agent-orch/session-utils'
import { deriveStatus } from '~/lib/derive-status'
import { useNow } from '~/lib/use-now'

interface ChainTimelineRowProps {
  session: SessionRecord
  active: boolean
  liveText?: string
  /** PR number from the chain's `ChainSummary.prNumber`, if any. */
  prNumber?: number
}

function deriveStatusLabel(derivedStatus: string): string {
  // GH#50: derivedStatus is the TTL-aware status (from `deriveStatus(session,
  // nowTs)`). D1 rows can carry terminal strings like 'completed' /
  // 'crashed' that predate or sidestep the narrow SessionStatus type, so
  // widen to string for the switch below.
  if (derivedStatus === 'completed') return 'done'
  if (derivedStatus === 'crashed') return 'crashed'
  if (derivedStatus === 'running') return 'live'
  if (derivedStatus.startsWith('waiting')) return 'waiting'
  return 'idle'
}

export function ChainTimelineRow({ session, active, liveText, prNumber }: ChainTimelineRowProps) {
  const ts = session.lastActivity ?? session.createdAt
  const mode = session.kataMode ?? 'session'
  const nowTs = useNow()
  const derivedStatus = deriveStatus(session, nowTs)
  const statusLabel = deriveStatusLabel(derivedStatus)
  const showPrChip = typeof prNumber === 'number' && session.kataMode === 'implementation'

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border px-3 py-2 ${
        active ? 'border-primary/60 bg-muted/30' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-3">
        <StatusDot status={derivedStatus} numTurns={session.numTurns ?? 0} />
        <Badge variant="outline" className="font-mono">
          {mode}
        </Badge>
        <span className="text-xs text-muted-foreground uppercase tracking-wide">{statusLabel}</span>
        <span className="text-xs text-muted-foreground">{formatTimeAgo(ts)}</span>
        <div className="ml-auto flex gap-1">
          {showPrChip ? <Badge variant="outline">PR #{prNumber}</Badge> : null}
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
