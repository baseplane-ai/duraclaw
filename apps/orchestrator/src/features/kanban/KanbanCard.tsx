/**
 * KanbanCard — single chain summary card on the /board surface.
 *
 * P3 U3 adds: Start-next button (with precondition gating + confirmation
 * modal), draggable-by-handle via `@dnd-kit/core`. PR chip, lane collapse,
 * and drag-to-advance live on the parent surfaces.
 */

import { useDraggable } from '@dnd-kit/core'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { PipelineDots } from '~/components/layout/nav-sessions'
import { Button } from '~/components/ui/button'
import type { SessionRecord } from '~/db/agent-sessions-collection'
import { WorktreeConflictModal } from '~/features/chain/WorktreeConflictModal'
import { formatTimeAgo } from '~/features/agent-orch/session-utils'
import { useChainCheckout } from '~/hooks/use-chain-checkout'
import { useNextModePrecondition } from '~/hooks/use-chain-preconditions'
import { useTabSync } from '~/hooks/use-tab-sync'
import type { ChainSummary, WorktreeReservation } from '~/lib/types'
import { AdvanceConfirmModal } from './AdvanceConfirmModal'
import { advanceChain, hasActiveSession } from './advance-chain'

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
  const { nextMode, nextLabel, canAdvance, reason, loading } = useNextModePrecondition(chain)
  const { forceRelease } = useChainCheckout()
  const [modalOpen, setModalOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [conflict, setConflict] = useState<WorktreeReservation | null>(null)

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card:${chain.issueNumber}`,
    data: { chain },
  })

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

  const handleStartNext = useCallback(() => {
    if (!nextMode || !canAdvance) return
    setModalOpen(true)
  }, [nextMode, canAdvance])

  const runAdvance = useCallback(async (): Promise<boolean> => {
    if (!nextMode) return false
    setPending(true)
    const res = await advanceChain(chain, nextMode)
    setPending(false)
    if (!res.ok) {
      if (res.conflict) {
        setModalOpen(false)
        setConflict(res.conflict)
        return false
      }
      toast.error(res.error ?? 'Failed to advance chain')
      return false
    }
    setModalOpen(false)
    toast.success(`Started ${nextMode} for #${chain.issueNumber}`)
    navigate({
      to: '/chain/$issueNumber',
      params: { issueNumber: String(chain.issueNumber) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    return true
  }, [chain, nextMode, navigate])

  const handleConfirm = useCallback(async () => {
    await runAdvance()
  }, [runAdvance])

  const handlePickDifferent = useCallback(() => {
    // No in-app worktree picker yet — close modal and let the user pick a
    // different worktree via the existing spawn form / worktrees panel.
    setConflict(null)
  }, [])

  const handleForceRelease = useCallback(async () => {
    if (!conflict) return
    setPending(true)
    const res = await forceRelease(conflict.issueNumber, conflict.worktree)
    if (!res.ok) {
      setPending(false)
      toast.error(res.error ?? 'Force release failed')
      return
    }
    // Clear conflict modal; retry the full advance (checkout re-runs).
    setConflict(null)
    setPending(false)
    await runAdvance()
  }, [conflict, forceRelease, runAdvance])

  const focus = pickFocusSession(chain.sessions)
  const focusTs = focus?.lastActivity ?? focus?.createdAt ?? chain.lastActivity
  const worktree = chain.worktreeReservation?.worktree ?? null
  const currentMode = focus?.kataMode ?? chain.column

  // PipelineDots expects SessionRecord[]. ChainSummary.sessions carry the
  // fields it reads (status, kataMode); numTurns is absent but only
  // matters for the "completed" dot colouring — treated as 0 which is a
  // safe under-report. Cast is deliberate.
  const sessionsForDots = chain.sessions as unknown as SessionRecord[]

  const hasActive = hasActiveSession(chain)
  const startLabel = nextMode
    ? hasActive
      ? `Close current + start ${nextLabel}`
      : `Start ${nextLabel}`
    : ''
  const disabledTitle = loading
    ? 'Checking preconditions…'
    : reason || (canAdvance ? '' : 'Precondition not met')

  return (
    <>
      <div
        ref={setNodeRef}
        className={`flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-sm shadow-sm transition-shadow hover:shadow-md ${
          isDragging ? 'opacity-50 shadow-lg' : ''
        }`}
        {...attributes}
        {...listeners}
      >
        <div className="line-clamp-2 text-xs font-medium leading-snug">
          <span className="text-muted-foreground">#{chain.issueNumber}</span>{' '}
          {chain.issueTitle}
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <PipelineDots sessions={sessionsForDots} />
          {focus ? (
            <span className="text-muted-foreground">
              {shortMode(focus.kataMode)} &middot; {shortStatusLabel(focus.status)}
              {focusTs ? ` &middot; ${formatTimeAgo(focusTs)}` : ''}
            </span>
          ) : (
            <span className="text-muted-foreground">no sessions</span>
          )}
        </div>
        {worktree ? (
          <div className="text-[11px] text-muted-foreground">
            <span className="font-mono">{worktree}</span>
          </div>
        ) : null}
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          {/* Prevent dnd-kit from intercepting the click on the buttons. */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            onClick={handleOpen}
            onPointerDown={(e) => e.stopPropagation()}
          >
            Open
          </Button>
          {nextMode ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={handleStartNext}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={!canAdvance || loading}
              title={disabledTitle || undefined}
            >
              {startLabel}
            </Button>
          ) : null}
        </div>
      </div>
      {nextMode ? (
        <AdvanceConfirmModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          issueNumber={chain.issueNumber}
          currentMode={currentMode}
          nextMode={nextMode}
          worktree={worktree}
          worktreeReserved={!!chain.worktreeReservation}
          onConfirm={handleConfirm}
          pending={pending}
        />
      ) : null}
      {conflict ? (
        <WorktreeConflictModal
          open={true}
          onOpenChange={(open) => {
            if (!open) setConflict(null)
          }}
          conflict={conflict}
          onPickDifferent={handlePickDifferent}
          onForceRelease={handleForceRelease}
          conflictTitle={`Blocking advance of #${chain.issueNumber}`}
        />
      ) : null}
    </>
  )
}
