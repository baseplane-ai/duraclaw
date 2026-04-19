/**
 * AdvanceConfirmModal — "Advance #N from X to Y?" dialog shown when the
 * user clicks Start-next on a kanban card or drops a card on its adjacent-
 * forward column (B9 / B10).
 *
 * Layout mirrors the spec (16-chain-ux.md lines 639-653). The "Reset
 * context" bullet is aspirational: the P3 degraded path just aborts +
 * respawns, which still gives the new runner a fresh sdk_session_id —
 * functionally equivalent to a context reset for the SDK. P4 will swap
 * in the preamble template.
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
  issueNumber: number
  currentMode: string
  nextMode: string
  worktree: string | null
  worktreeReserved: boolean
  onConfirm: () => void
  pending?: boolean
}

export function AdvanceConfirmModal({
  open,
  onOpenChange,
  issueNumber,
  currentMode,
  nextMode,
  worktree,
  worktreeReserved,
  onConfirm,
  pending,
}: AdvanceConfirmModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Advance #{issueNumber} from {currentMode} to {nextMode}?
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <p className="text-muted-foreground mb-1">This will:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Close the current {currentMode} session</li>
              <li>Start a fresh {nextMode} session</li>
              <li>Reset context (new SDK session)</li>
            </ul>
          </div>
          {worktree ? (
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
          <Button onClick={onConfirm} disabled={pending}>
            Advance →
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
