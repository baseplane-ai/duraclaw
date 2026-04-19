/**
 * KanbanCard — single chain summary card on the /board surface.
 *
 * Read-only (P3 U2): no drag, no Start-next, no PR chip. U3 adds those.
 */

import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { PipelineDots } from '~/components/layout/nav-sessions'
import { Button } from '~/components/ui/button'
import type { SessionRecord } from '~/db/agent-sessions-collection'
import { formatTimeAgo } from '~/features/agent-orch/session-utils'
import { useTabSync } from '~/hooks/use-tab-sync'
import type { ChainSummary } from '~/lib/types'

interface KanbanCardProps {
  chain: ChainSummary
}

/** Freshest live / non-terminal session for the status strip. */
function pickFocusSession(
  sessions: ChainSummary['sessions'],
): ChainSummary['sessions'][number] | null {
  if (sessions.length === 0) return null
  const byActivity = [...sessions].sort((a, b) => {
    const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
    const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
    return bTime - aTime
  })
  return byActivity[0] ?? null
}

function shortStatusLabel(status: string): string {
  if (status === 'running') return 'live'
  if (status === 'completed') return 'done'
  if (status === 'crashed') return 'crashed'
  if (status.startsWith('waiting')) return 'waiting'
  return 'idle'
}

function shortMode(mode: string | null | undefined): string {
  if (!mode) return '—'
  if (mode === 'implementation') return 'impl'
  return mode
}

export function KanbanCard({ chain }: KanbanCardProps) {
  const navigate = useNavigate()
  const { openTab } = useTabSync()

  const handleOpen = useCallback(() => {
    openTab(`chain:${chain.issueNumber}`, {
      kind: 'chain',
      issueNumber: chain.issueNumber,
    })
    navigate({
      to: '/chain/$issueNumber',
      params: { issueNumber: String(chain.issueNumber) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }, [chain.issueNumber, navigate, openTab])

  const focus = pickFocusSession(chain.sessions)
  const focusTs = focus?.lastActivity ?? focus?.createdAt ?? chain.lastActivity
  const worktree = chain.worktreeReservation?.worktree

  // PipelineDots expects SessionRecord[]. ChainSummary.sessions carry the
  // fields it reads (status, kataMode); numTurns is absent but only
  // matters for the "completed" dot colouring — treated as 0 which is a
  // safe under-report. Cast is deliberate.
  const sessionsForDots = chain.sessions as unknown as SessionRecord[]

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-card px-2 py-2 text-xs">
      <div className="truncate font-medium">
        #{chain.issueNumber} — {chain.issueTitle}
      </div>
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span>{chain.issueType}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        <PipelineDots sessions={sessionsForDots} />
        {focus ? (
          <>
            <span className="text-muted-foreground">
              {shortMode(focus.kataMode)} {shortStatusLabel(focus.status)}
            </span>
            <span className="text-muted-foreground">{formatTimeAgo(focusTs)}</span>
          </>
        ) : (
          <span className="text-muted-foreground">no sessions</span>
        )}
      </div>
      {worktree ? (
        <div className="text-[10px] text-muted-foreground">wt: {worktree}</div>
      ) : null}
      <div className="mt-1">
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={handleOpen}>
          Open
        </Button>
      </div>
    </div>
  )
}
