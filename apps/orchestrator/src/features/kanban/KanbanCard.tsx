/**
 * KanbanCard — single chain summary card on the /board surface.
 *
 * P3 U3 adds: Start-next button (with precondition gating + confirmation
 * modal), draggable-by-handle via `@dnd-kit/core`. PR chip, lane collapse,
 * and drag-to-advance live on the parent surfaces.
 */

import { useDraggable } from '@dnd-kit/core'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PipelineDots } from '~/components/layout/nav-sessions'
import { Button } from '~/components/ui/button'
import { projectsCollection } from '~/db/projects-collection'
import type { SessionRecord } from '~/db/session-record'
import { formatTimeAgo } from '~/features/agent-orch/session-utils'
import { WorktreeConflictModal } from '~/features/chain/WorktreeConflictModal'
import { useChainAutoAdvance } from '~/hooks/use-chain-auto-advance'
import { useChainCheckout } from '~/hooks/use-chain-checkout'
import { useNextModePrecondition } from '~/hooks/use-chain-preconditions'
import { useTabSync } from '~/hooks/use-tab-sync'
import { isChainSessionCompleted } from '~/lib/chains'
import type { ChainSummary, WorktreeReservation } from '~/lib/types'
import { AdvanceConfirmModal } from './AdvanceConfirmModal'
import { advanceChain, chainProject, hasActiveSession } from './advance-chain'

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

function shortStatusLabel(session: ChainSummary['sessions'][number]): string {
  const { status } = session
  if (status === 'running') return 'live'
  if (status === 'crashed') return 'crashed'
  if (status.startsWith('waiting')) return 'waiting'
  // `isChainSessionCompleted` recognises the D1 terminal "rung finished"
  // shape (status === 'idle' && lastActivity != null). An `'idle'` session
  // with no lastActivity is freshly spawned — render plain idle.
  if (isChainSessionCompleted(session)) return 'done'
  return 'idle'
}

function shortMode(mode: string | null | undefined): string {
  if (!mode) return '—'
  if (mode === 'implementation') return 'impl'
  return mode
}

export function KanbanCard({ chain }: KanbanCardProps) {
  const { openTab } = useTabSync()
  const { nextMode, nextLabel, canAdvance, reason, loading } = useNextModePrecondition(chain)
  const { forceRelease } = useChainCheckout()
  const [modalOpen, setModalOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [conflict, setConflict] = useState<WorktreeReservation | null>(null)
  // Backlog-bootstrap: when a chain has zero sessions, the user picks a
  // worktree via the Advance modal. Empty-string = "no selection yet", which
  // is what disables the confirm button.
  const [pickedProject, setPickedProject] = useState<string>('')

  // Project list for the picker — only queried when we actually need it
  // (the modal hasn't been opened yet on most cards, but useLiveQuery is
  // cheap here since `projectsCollection` is a single module-level
  // collection shared across the app).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectsData } = useLiveQuery(projectsCollection as any)
  const projectOptions = useMemo(() => {
    if (!projectsData) return [] as string[]
    return (projectsData as Array<{ name: string }>).map((p) => p.name).sort()
  }, [projectsData])

  // Per-chain auto-advance toggle — same preference the StatusBar
  // ChainStatusItem popover drives, surfaced on the card itself so users
  // can flip it before any session exists (GH#82 "auto-advance hidden").
  const { enabled: autoAdvanceOn, toggle: toggleAutoAdvance } = useChainAutoAdvance(
    chain.issueNumber,
  )

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card:${chain.issueNumber}`,
    data: { chain },
  })

  const handleOpen = useCallback(() => {
    if (chain.sessions.length === 0) return
    const sorted = [...chain.sessions].sort((a, b) => {
      const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
      const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
      return bTime - aTime
    })
    const latestSessionId = sorted[0]?.id
    if (!latestSessionId) return
    openTab(latestSessionId, { project: chainProject(chain) ?? undefined })
  }, [chain, openTab])

  const handleStartNext = useCallback(() => {
    if (!nextMode || !canAdvance) return
    // Reset the picker state each time the modal opens — avoids a stale
    // selection from a prior attempt persisting into a new session.
    setPickedProject('')
    setModalOpen(true)
  }, [nextMode, canAdvance])

  const runAdvance = useCallback(async (): Promise<boolean> => {
    if (!nextMode) return false
    // Backlog-bootstrap: empty chains have no prior project, so surface the
    // user's pick from the modal's worktree picker. Existing chains ignore
    // the override.
    const existingProject = chainProject(chain)
    const projectOverride = existingProject ? null : pickedProject || null
    if (!existingProject && !projectOverride) {
      toast.error('Pick a worktree before advancing')
      return false
    }
    setPending(true)
    const res = await advanceChain(chain, nextMode, { projectOverride })
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
    openTab(res.sessionId, { project: existingProject ?? projectOverride ?? undefined })
    return true
  }, [chain, nextMode, openTab, pickedProject])

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
        <div className="flex items-start justify-between gap-2">
          <div className="line-clamp-2 text-xs font-medium leading-snug">
            <span className="text-muted-foreground">#{chain.issueNumber}</span> {chain.issueTitle}
          </div>
          <button
            type="button"
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              autoAdvanceOn
                ? 'bg-primary/15 text-primary hover:bg-primary/25'
                : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
            title={
              autoAdvanceOn
                ? 'Auto-advance on — click to disable'
                : 'Auto-advance off — click to enable'
            }
            onClick={(e) => {
              e.stopPropagation()
              void toggleAutoAdvance()
            }}
            onPointerDown={(e) => e.stopPropagation()}
            data-testid={`chain-auto-chip-${chain.issueNumber}`}
          >
            ⟲ {autoAdvanceOn ? 'auto' : 'off'}
          </button>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <PipelineDots sessions={sessionsForDots} />
          {focus ? (
            <span className="text-muted-foreground">
              {shortMode(focus.kataMode)} &middot; {shortStatusLabel(focus)}
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
          {chain.sessions.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={handleOpen}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Open
            </Button>
          ) : null}
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
          projectOptions={chain.sessions.length === 0 ? projectOptions : undefined}
          selectedProject={pickedProject || null}
          onProjectChange={setPickedProject}
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
