/**
 * KanbanLane — horizontal swim lane grouping by issue type.
 *
 * Renders a header (name + count + collapse toggle) plus a 6-column grid
 * of KanbanColumns when expanded.
 */

import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ChainSummary } from '~/lib/types'
import { KanbanColumn } from './KanbanColumn'

/** Fixed column order, matches ChainSummary['column']. */
const COLUMNS: ReadonlyArray<ChainSummary['column']> = [
  'backlog',
  'research',
  'planning',
  'implementation',
  'verify',
  'done',
]

const COLUMN_LABELS: Record<ChainSummary['column'], string> = {
  backlog: 'Backlog',
  research: 'Research',
  planning: 'Planning',
  implementation: 'Implementation',
  verify: 'Verify',
  done: 'Done',
}

interface KanbanLaneProps {
  name: string
  cards: ChainSummary[]
  collapsed: boolean
  onToggle: () => void
}

export function KanbanLane({ name, cards, collapsed, onToggle }: KanbanLaneProps) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
      <button
        type="button"
        className="flex items-center gap-2 text-sm font-medium"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRight className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
        <span className="capitalize">{name}</span>
        <span className="text-xs text-muted-foreground">({cards.length})</span>
      </button>
      {collapsed ? null : (
        <div className="grid grid-cols-6 gap-2">
          {COLUMNS.map((col) => {
            const colCards = cards.filter((c) => c.column === col)
            return <KanbanColumn key={col} title={COLUMN_LABELS[col]} cards={colCards} />
          })}
        </div>
      )}
    </section>
  )
}
