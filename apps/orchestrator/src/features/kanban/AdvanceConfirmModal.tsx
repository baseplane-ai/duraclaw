/**
 * AdvanceConfirmModal — "Advance '<arc title>' from X to Y?" dialog
 * shown when the user clicks Start-next on a kanban card or drops a
 * card on its adjacent-forward column (B9 / B10).
 *
 * GH#116 P4a: title now reads from the arc title rather than the
 * GitHub issue number — for non-GH arcs there's no `#N` to display.
 */

import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'

export interface AdvanceConfirmModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Arc title (user-editable; auto-filled from external ref when present). */
  arcTitle: string
  currentMode: string
  nextMode: string
  /**
   * Resolved worktree (either from an existing arc reservation or the
   * user's pick from `projectOptions`). When `null`, the modal renders
   * the project picker and disables the confirm button until the user
   * chooses one.
   */
  worktree: string | null
  worktreeReserved: boolean
  /**
   * Backlog-bootstrap branch: when an arc has zero sessions, the caller
   * resolves the project list itself (typically from
   * `projectsCollection`) and hands it in so the modal can render a
   * picker. Unused for in-progress arcs (where `worktree` is already
   * set).
   */
  projectOptions?: readonly string[]
  selectedProject?: string | null
  onProjectChange?: (project: string) => void
  onConfirm: () => void
  pending?: boolean
}

export function AdvanceConfirmModal({
  open,
  onOpenChange,
  arcTitle,
  currentMode,
  nextMode,
  worktree,
  worktreeReserved,
  projectOptions,
  selectedProject,
  onProjectChange,
  onConfirm,
  pending,
}: AdvanceConfirmModalProps) {
  const needsPicker = worktree === null && projectOptions !== undefined && projectOptions.length > 0
  const confirmDisabled = pending || (needsPicker && !selectedProject)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Advance '{arcTitle}' from {currentMode} to {nextMode}?
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <div>
            <p className="text-muted-foreground mb-1">This will:</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              <li>Close the current {currentMode} session</li>
              <li>Start a fresh {nextMode} session</li>
              <li>Reset context (new SDK session)</li>
            </ul>
          </div>
          {needsPicker ? (
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Project / worktree</span>
              <select
                className="rounded border border-input bg-background px-2 py-1 text-sm"
                value={selectedProject ?? ''}
                onChange={(e) => onProjectChange?.(e.target.value)}
                disabled={pending}
                data-testid="advance-project-picker"
              >
                <option value="" disabled>
                  Select a worktree…
                </option>
                {projectOptions?.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          ) : worktree ? (
            <p className="text-muted-foreground">
              Worktree: {worktree}
              {worktreeReserved ? ' (reserved)' : ''}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={confirmDisabled}>
            Advance →
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
