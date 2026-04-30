/**
 * AdvanceModalHost — single layout-level mount for the global "advance arc"
 * modal flow, driven by the singleton store at `~/lib/advance-modal-store`.
 *
 * Only one advance modal can be open at a time across the whole app, so
 * rather than letting every trigger (KanbanCard, ArcStatusItem, etc.) own
 * its own copy of the modal + form state, we mount this host once at
 * layout level and have triggers call `openAdvance(arc, nextMode)` to
 * summon it. KanbanCard and ArcStatusItem no longer mount their own
 * `<AdvanceConfirmModal>` / `<WorktreeConflictModal>`.
 *
 * Issue #151 (arc-first UI overhaul), task TK-6484-0430.
 */

import { useLiveQuery } from '@tanstack/react-db'
import type React from 'react'
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { projectsCollection } from '~/db/projects-collection'
import { WorktreeConflictModal } from '~/features/chain/WorktreeConflictModal'
import { AdvanceConfirmModal } from '~/features/kanban/AdvanceConfirmModal'
import { advanceArc } from '~/features/kanban/advance-arc'
import { useArcCheckout } from '~/hooks/use-arc-checkout'
import { useTabSync } from '~/hooks/use-tab-sync'
import {
  closeAdvance,
  setConflict,
  setPending,
  setPickedProject,
  useAdvanceModalState,
} from '~/lib/advance-modal-store'
import { deriveColumn } from '~/lib/arcs'

export function AdvanceModalHost(): React.JSX.Element | null {
  const { arc, nextMode, pickedProject, pending, conflict } = useAdvanceModalState()
  const { openTab } = useTabSync()
  const { forceRelease } = useArcCheckout()

  // Project list for the picker — only used in the backlog-bootstrap
  // branch (arcs with zero sessions). useLiveQuery is cheap here since
  // `projectsCollection` is a single module-level collection shared
  // across the app.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectsData } = useLiveQuery(projectsCollection as any)
  const projectOptions = useMemo(() => {
    if (!projectsData) return [] as string[]
    return (projectsData as Array<{ name: string }>).map((p) => p.name).sort()
  }, [projectsData])

  const runAdvance = useCallback(async (): Promise<boolean> => {
    if (!arc || !nextMode) return false
    // Backlog-bootstrap: arcs with zero sessions don't have a prior
    // session whose project the server can inherit, so the Advance
    // modal renders a project picker and we forward the pick as
    // `projectOverride`. For arcs that already have sessions we send
    // no override — the server prefers `body.project` only when given,
    // otherwise it inherits from the latest prior session. The server
    // still returns 400 `no_project_for_arc` if both are missing.
    setPending(true)
    const res = await advanceArc(arc, nextMode, {
      projectOverride: arc.sessions.length === 0 && pickedProject ? pickedProject : null,
    })
    setPending(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to advance arc')
      return false
    }
    toast.success(`Started ${nextMode} in arc '${arc.title}'`)
    const projectLabel = arc.worktreeReservation?.worktree.split('/').pop()
    openTab(res.sessionId, { project: projectLabel ?? undefined })
    closeAdvance()
    return true
  }, [arc, nextMode, pickedProject, openTab])

  const handleConfirm = useCallback(async () => {
    await runAdvance()
  }, [runAdvance])

  const handlePickDifferent = useCallback(() => {
    // No in-app worktree picker yet — close conflict modal and let the
    // user pick a different worktree via the existing spawn form /
    // worktrees panel.
    setConflict(null)
  }, [])

  const handleForceRelease = useCallback(async () => {
    if (!conflict) return
    setPending(true)
    // GH#116 P4a: force-release is keyed on worktree id (admin
    // DELETE /api/worktrees/:id). Use the conflict row's id directly.
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

  // Hooks above must run unconditionally; bail to null only after they've
  // all subscribed.
  if (!arc || !nextMode) return null

  const column = deriveColumn(arc.sessions, arc.status)
  // KanbanCard uses `pickFocusSession` for richer card UI; for the modal
  // title we just need a current-mode label, so the simple "first session
  // or fallback to column" shape matches KanbanCard's
  // `currentMode = focus?.mode ?? column` precision adequately.
  const focus = arc.sessions[0] ?? null
  const currentMode = focus?.mode ?? column
  const worktree = arc.worktreeReservation?.worktree.split('/').pop() ?? null

  return (
    <>
      <AdvanceConfirmModal
        open={true}
        onOpenChange={(open) => {
          if (!open) closeAdvance()
        }}
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
