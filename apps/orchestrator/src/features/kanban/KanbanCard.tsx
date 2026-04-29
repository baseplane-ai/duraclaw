/**
 * KanbanCard — single arc summary card on the /board surface.
 *
 * GH#116 P4a: card data shape is `ArcSummary` (was `ChainSummary`).
 * Display fields:
 *   - issue badge `#N` is shown only for GH-linked arcs (`externalRef.provider === 'github'`)
 *   - title comes from `arc.title` (user-editable, auto-filled from external ref)
 *   - column is derived via `deriveColumn(arc.sessions, arc.status)`
 *   - session focus reads `arc.sessions[].mode` (was `kataMode`)
 *
 * The use-arc-* hooks (auto-advance, preconditions, checkout) consume
 * `ArcSummary` / arc.id directly. Auto-advance still keys on
 * issueNumber under the hood (preference shape unchanged); for non-GH
 * arcs we hide the chip rather than wire a synthetic key.
 *
 * P3 U3 adds: Start-next button (with precondition gating + confirmation
 * modal), draggable-by-handle via `@dnd-kit/core`. PR chip, lane collapse,
 * and drag-to-advance live on the parent surfaces.
 */

import { useDraggable } from '@dnd-kit/core'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { projectsCollection } from '~/db/projects-collection'
import { formatTimeAgo } from '~/features/agent-orch/session-utils'
import { WorktreeConflictModal } from '~/features/chain/WorktreeConflictModal'
import { useArcAutoAdvance } from '~/hooks/use-arc-auto-advance'
import { useArcCheckout } from '~/hooks/use-arc-checkout'
import { useNextModePrecondition } from '~/hooks/use-arc-preconditions'
import { useTabSync } from '~/hooks/use-tab-sync'
import { deriveColumn } from '~/lib/arcs'
import { isChainSessionCompleted } from '~/lib/chains'
import type { ArcSummary, ChainWorktreeReservation } from '~/lib/types'
import { AdvanceConfirmModal } from './AdvanceConfirmModal'
import { advanceArc, hasActiveSession } from './advance-arc'

interface KanbanCardProps {
  arc: ArcSummary
}

/** Freshest live / non-terminal session for the status strip. */
function pickFocusSession(sessions: ArcSummary['sessions']): ArcSummary['sessions'][number] | null {
  if (sessions.length === 0) return null
  const byActivity = [...sessions].sort((a, b) => {
    const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
    const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
    return bTime - aTime
  })
  return byActivity[0] ?? null
}

function shortStatusLabel(session: ArcSummary['sessions'][number]): string {
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

export function KanbanCard({ arc }: KanbanCardProps) {
  const { openTab } = useTabSync()

  const column = useMemo(() => deriveColumn(arc.sessions, arc.status), [arc.sessions, arc.status])

  const { nextMode, nextLabel, canAdvance, reason, loading } = useNextModePrecondition(arc)
  const { forceRelease } = useArcCheckout()
  const [modalOpen, setModalOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [conflict, setConflict] = useState<ChainWorktreeReservation | null>(null)
  // Backlog-bootstrap: when an arc has zero sessions, the user picks a
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

  // Per-arc auto-advance toggle — same preference the StatusBar
  // ArcStatusItem popover drives, surfaced on the card itself so users
  // can flip it before any session exists. The legacy preference is
  // keyed on issueNumber — hide the chip for non-GH arcs to avoid
  // surfacing a no-op button against a synthetic key.
  const ghIssueNumber =
    arc.externalRef?.provider === 'github' && typeof arc.externalRef.id === 'number'
      ? arc.externalRef.id
      : 0
  const { enabled: autoAdvanceOn, toggle: toggleAutoAdvance } = useArcAutoAdvance(ghIssueNumber)
  const showAutoChip = arc.externalRef?.provider === 'github' && ghIssueNumber > 0

  const issueLabel =
    arc.externalRef?.provider === 'github' && typeof arc.externalRef.id === 'number'
      ? `#${arc.externalRef.id}`
      : null

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card:${arc.id}`,
    data: { arc },
  })

  const handleOpen = useCallback(() => {
    if (arc.sessions.length === 0) return
    const sorted = [...arc.sessions].sort((a, b) => {
      const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
      const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
      return bTime - aTime
    })
    const latestSessionId = sorted[0]?.id
    if (!latestSessionId) return
    const projectLabel = arc.worktreeReservation?.worktree.split('/').pop()
    openTab(latestSessionId, { project: projectLabel ?? undefined })
  }, [arc, openTab])

  const handleStartNext = useCallback(() => {
    if (!nextMode || !canAdvance) return
    // Reset the picker state each time the modal opens — avoids a stale
    // selection from a prior attempt persisting into a new session.
    setPickedProject('')
    setModalOpen(true)
  }, [nextMode, canAdvance])

  const runAdvance = useCallback(async (): Promise<boolean> => {
    if (!nextMode) return false
    // Backlog-bootstrap: arcs without a worktree reservation can't
    // advance into a code-touching mode. The picker exists to nudge the
    // user toward a separate `POST /api/worktrees` reserve step (P4b
    // wiring). The server returns 400 `no_project_for_arc` here if the
    // arc has no prior session and no worktree.
    setPending(true)
    const res = await advanceArc(arc, nextMode)
    setPending(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to advance arc')
      return false
    }
    setModalOpen(false)
    toast.success(`Started ${nextMode} in arc '${arc.title}'`)
    const projectLabel = arc.worktreeReservation?.worktree.split('/').pop()
    openTab(res.sessionId, { project: projectLabel ?? undefined })
    return true
  }, [arc, nextMode, openTab])

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
    // GH#116 P4a: force-release is now keyed on worktree id (admin
    // DELETE /api/worktrees/:id). Use the conflict row's id directly;
    // the legacy `(issueNumber, worktree)` signature is gone with the
    // chain endpoint deletion.
    const res = await forceRelease(conflict.id)
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

  const focus = pickFocusSession(arc.sessions)
  const focusTs = focus?.lastActivity ?? focus?.createdAt ?? arc.lastActivity
  const worktree = arc.worktreeReservation?.worktree.split('/').pop() ?? null
  const currentMode = focus?.mode ?? column

  const hasActive = hasActiveSession(arc)
  const startLabel = nextMode ? `Start ${nextLabel}` : ''
  const disabledTitle = loading
    ? 'Checking preconditions…'
    : reason || (canAdvance ? '' : 'Precondition not met')
  const startTooltip =
    disabledTitle || (hasActive ? `Closes current session, starts fresh ${nextLabel}` : undefined)

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
          <div className="min-w-0 flex-1">
            {issueLabel ? (
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {issueLabel}
              </div>
            ) : null}
            <div className="line-clamp-2 text-sm font-medium leading-snug" title={arc.title}>
              {arc.title}
            </div>
          </div>
          {showAutoChip ? (
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
              data-testid={`arc-auto-chip-${arc.id}`}
            >
              ⟲ {autoAdvanceOn ? 'auto' : 'off'}
            </button>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          {focus ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {shortMode(focus.mode)} &middot; {shortStatusLabel(focus)}
              {focusTs ? ` &middot; ${formatTimeAgo(focusTs)}` : ''}
            </span>
          ) : (
            <span className="text-muted-foreground">no sessions</span>
          )}
        </div>
        {worktree ? (
          <div className="min-w-0 text-[11px] text-muted-foreground">
            <span className="block truncate font-mono" title={worktree}>
              {worktree}
            </span>
          </div>
        ) : null}
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          {/* Prevent dnd-kit from intercepting the click on the buttons. */}
          {arc.sessions.length > 0 ? (
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
              title={startTooltip}
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
          arcTitle={arc.title}
          currentMode={currentMode}
          nextMode={nextMode}
          worktree={worktree}
          worktreeReserved={!!arc.worktreeReservation}
          projectOptions={arc.sessions.length === 0 ? projectOptions : undefined}
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
          conflictTitle={`Blocking advance of '${arc.title}'`}
        />
      ) : null}
    </>
  )
}
