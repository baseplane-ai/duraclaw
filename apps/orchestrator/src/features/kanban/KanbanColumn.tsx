/**
 * KanbanColumn — one phase column inside a lane row.
 *
 * Uses a fixed min-width so the parent's horizontal scroll activates on
 * narrow viewports. On desktop the columns flex-grow to fill available space.
 */

import { useDroppable } from '@dnd-kit/core'
import type { ChainSummary } from '~/lib/types'
import { KanbanCard } from './KanbanCard'

interface KanbanColumnProps {
  title: string
  cards: ChainSummary[]
  /** Drop-zone id wired up by KanbanBoard (`drop:<lane>:<column>`). */
  dropId: string
  /** Preserved for API compatibility — the inline Create-chain form was
   *  removed alongside the `/chain/:issueNumber` route (spec 16-p1-5 B1).
   *  Chains now appear via GitHub webhook refresh, not manual add. */
  isBacklog?: boolean
}

export function KanbanColumn({ title, cards, dropId, isBacklog: _isBacklog }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      className={`flex min-w-[220px] flex-1 shrink-0 snap-start flex-col gap-2 overflow-hidden rounded-lg border p-2.5 transition-colors ${
        isOver ? 'border-primary bg-primary/5' : 'border-border/50 bg-background/50'
      }`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-0.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {cards.length}
        </span>
      </div>

      {/* Card stack */}
      <div className="flex flex-col gap-2">
        {cards.map((chain) => (
          <KanbanCard key={chain.issueNumber} chain={chain} />
        ))}
      </div>
    </div>
  )
}
