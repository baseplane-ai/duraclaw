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
import type { ChainWorktreeReservation } from '~/lib/types'

export interface WorktreeConflictModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conflict: ChainWorktreeReservation
  /** Called when user clicks "Pick different worktree". Parent shows picker. */
  onPickDifferent: () => void
  /** Called when user confirms force-release. Parent calls API. */
  onForceRelease: () => void
  /** Optional — if known (e.g. from ArcSummary), shown under the title. */
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
            {/* GH#115: legacy `worktree` (project name) is now the basename
                of the new `path`; legacy `issueNumber` is `reservedBy.id`
                when the holder is an arc (the only case that reaches this
                modal in the chain flow). */}
            Worktree {conflict.path.split('/').pop() || conflict.path} is held by{' '}
            {conflict.reservedBy?.kind === 'arc'
              ? `chain #${conflict.reservedBy.id}`
              : `${conflict.reservedBy?.kind ?? 'unknown'}:${conflict.reservedBy?.id ?? '?'}`}
          </DialogTitle>
          {conflictTitle ? <DialogDescription>{conflictTitle}</DialogDescription> : null}
        </DialogHeader>

        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">owner:</span> {conflict.ownerId}
          </li>
          <li>
            <span className="font-medium text-foreground">last activity:</span>{' '}
            {formatTimeAgo(new Date(conflict.lastTouchedAt).toISOString())}
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
