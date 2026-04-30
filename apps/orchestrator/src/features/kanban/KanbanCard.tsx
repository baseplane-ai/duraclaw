/**
 * KanbanCard — single arc summary card on the /board surface.
 *
 * Card data shape is `ArcSummary`. Display fields:
 *   - issue badge `#N` is shown only for GH-linked arcs (`externalRef.provider === 'github'`)
 *   - title comes from `arc.title` (user-editable, auto-filled from external ref)
 *   - session focus reads `arc.sessions[].mode` (was `kataMode`)
 *
 * The use-arc-* hooks (auto-advance, preconditions) consume `ArcSummary` /
 * arc.id directly. Auto-advance still keys on issueNumber under the hood
 * (preference shape unchanged); for non-GH arcs we hide the chip rather
 * than wire a synthetic key.
 *
 * The Start-next button just calls `openAdvance(arc, nextMode)` on the
 * singleton advance-modal store; the modal lifecycle (confirm flow,
 * worktree-conflict resolution, toasts, openTab on success) lives in
 * `<AdvanceModalHost />`, mounted once at the authenticated layout.
 * Drag-to-advance and lane collapse live on the parent surfaces.
 */

import { useDraggable } from '@dnd-kit/core'
import { useCallback } from 'react'
import { Button } from '~/components/ui/button'
import { formatTimeAgo } from '~/features/agent-orch/session-utils'
import { useArcAutoAdvance } from '~/hooks/use-arc-auto-advance'
import { useNextModePrecondition } from '~/hooks/use-arc-preconditions'
import { useTabSync } from '~/hooks/use-tab-sync'
import { openAdvance } from '~/lib/advance-modal-store'
import { isArcSessionCompleted, isLiveSession } from '~/lib/arcs'
import type { ArcSummary } from '~/lib/types'
import { hasActiveSession } from './advance-arc'

interface KanbanCardProps {
  arc: ArcSummary
}

/**
 * Freshest live session (preferred) — falls back to the most recently
 * touched session when none are live.
 *
 * The pre-cleanup version sorted by activity unconditionally, which
 * surfaced stale terminal sessions as "focus" even when a fresh live
 * one was right next to it in the same arc. Liveness now wins; among
 * live sessions the most-recently-spawned (by createdAt — `running` /
 * `pending` rows often have no `lastActivity` yet) is picked.
 */
function pickFocusSession(sessions: ArcSummary['sessions']): ArcSummary['sessions'][number] | null {
  if (sessions.length === 0) return null
  const live = sessions.filter(isLiveSession)
  if (live.length > 0) {
    return (
      [...live].sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime()
        const bTime = new Date(b.createdAt).getTime()
        return bTime - aTime
      })[0] ?? null
    )
  }
  // No live session — show the freshest terminal so the card still
  // reflects something useful (last completed rung, or last error).
  return (
    [...sessions].sort((a, b) => {
      const aTime = new Date(a.lastActivity ?? a.createdAt).getTime()
      const bTime = new Date(b.lastActivity ?? b.createdAt).getTime()
      return bTime - aTime
    })[0] ?? null
  )
}

function shortStatusLabel(session: ArcSummary['sessions'][number]): string {
  const { status } = session
  if (status === 'running') return 'live'
  if (status === 'error') return 'error'
  if (status.startsWith('waiting')) return 'waiting'
  if (status === 'failover') return 'failover'
  // `isArcSessionCompleted` recognises the D1 terminal "rung finished"
  // shape (status === 'idle' && lastActivity != null). An `'idle'` session
  // with no lastActivity is freshly spawned — render plain idle.
  if (isArcSessionCompleted(session)) return 'done'
  return 'idle'
}

function shortMode(mode: string | null | undefined): string {
  if (!mode) return '—'
  if (mode === 'implementation') return 'impl'
  return mode
}

export function KanbanCard({ arc }: KanbanCardProps) {
  const { openTab } = useTabSync()

  const { nextMode, nextLabel, canAdvance, reason, loading } = useNextModePrecondition(arc)

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
    openAdvance(arc, nextMode)
  }, [arc, nextMode, canAdvance])

  const focus = pickFocusSession(arc.sessions)
  const focusTs = focus?.lastActivity ?? focus?.createdAt ?? arc.lastActivity
  const worktree = arc.worktreeReservation?.worktree.split('/').pop() ?? null
  const worktreeStale = arc.worktreeReservation?.stale === true

  const hasActive = hasActiveSession(arc)
  const startLabel = nextMode ? `Start ${nextLabel}` : ''
  const disabledTitle = loading
    ? 'Checking preconditions…'
    : reason || (canAdvance ? '' : 'Precondition not met')
  const startTooltip =
    disabledTitle || (hasActive ? `Closes current session, starts fresh ${nextLabel}` : undefined)

  return (
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
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <span
            className={`block min-w-0 flex-1 truncate font-mono ${worktreeStale ? 'text-amber-600 dark:text-amber-500' : ''}`}
            title={worktreeStale ? `${worktree} (stale — held >7d)` : worktree}
          >
            {worktree}
          </span>
          {worktreeStale ? (
            <span
              className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400"
              title="Reservation hasn't been touched in over 7 days"
              data-testid={`arc-worktree-stale-${arc.id}`}
            >
              stale
            </span>
          ) : null}
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
  )
}
