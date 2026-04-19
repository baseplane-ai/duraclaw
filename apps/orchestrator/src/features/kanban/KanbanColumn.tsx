/**
 * KanbanColumn — one phase column inside a lane row.
 *
 * Read-only (P3 U2): no drop target, no Start-next / Backlog-new buttons.
 */

import type { ChainSummary } from '~/lib/types'
import { KanbanCard } from './KanbanCard'

interface KanbanColumnProps {
  title: string
  cards: ChainSummary[]
}

export function KanbanColumn({ title, cards }: KanbanColumnProps) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border/60 p-2">
      <div className="flex items-center justify-between px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        <span>{cards.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {cards.map((chain) => (
          <KanbanCard key={chain.issueNumber} chain={chain} />
        ))}
      </div>
    </div>
  )
}
