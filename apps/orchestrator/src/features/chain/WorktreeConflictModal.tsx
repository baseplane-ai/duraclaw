/**
 * WorktreeConflictModal — shown when a code-touching spawn attempt hits a 409
 * from `POST /api/chains/:issue/checkout`. Renders the conflicting
 * reservation (chain issue number, owner, timestamps) and three CTAs:
 * "Pick different worktree", "Force release" (only when `conflict.stale`),
 * and "Cancel".
 *
 * Parents are responsible for actually opening the worktree picker, calling
 * the force-release API, and re-running the checkout flow on success. See
 * GH#16 Feature 3E B13 in `planning/specs/16-chain-ux.md`.
 */

import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { formatTimeAgo } from '~/features/agent-orch/session-utils'
import type { WorktreeReservation } from '~/lib/types'

export interface WorktreeConflictModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conflict: WorktreeReservation
  /** Called when user clicks "Pick different worktree". Parent shows picker. */
  onPickDifferent: () => void
  /** Called when user confirms force-release. Parent calls API. */
  onForceRelease: () => void
  /** Optional — if known (e.g. from ChainSummary), shown under the title. */
  conflictTitle?: string
}

const FORCE_RELEASE_DISABLED_TOOLTIP = 'Reservation not stale — 7 days of inactivity required'

export function WorktreeConflictModal({
  open,
  onOpenChange,
  conflict,
  onPickDifferent,
  onForceRelease,
  conflictTitle,
}: WorktreeConflictModalProps) {
  const forceDisabled = !conflict.stale

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Worktree {conflict.worktree} is held by chain #{conflict.issueNumber}
          </DialogTitle>
          {conflictTitle ? <DialogDescription>{conflictTitle}</DialogDescription> : null}
        </DialogHeader>

        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">owner:</span> {conflict.ownerId}
          </li>
          <li>
            <span className="font-medium text-foreground">held since:</span>{' '}
            {formatTimeAgo(conflict.heldSince)}
          </li>
          <li>
            <span className="font-medium text-foreground">last activity:</span>{' '}
            {formatTimeAgo(conflict.lastActivityAt)}
          </li>
          <li>
            <span className="font-medium text-foreground">stale:</span>{' '}
            {conflict.stale ? 'yes' : 'no'}
          </li>
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={onPickDifferent}>
            Pick different worktree
          </Button>
          <Button
            variant="destructive"
            onClick={onForceRelease}
            disabled={forceDisabled}
            title={forceDisabled ? FORCE_RELEASE_DISABLED_TOOLTIP : undefined}
          >
            Force release
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
