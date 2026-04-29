/**
 * KanbanLane — horizontal swim lane grouping by external-ref provider.
 *
 * Each lane holds an `ArcSummary[]`. Columns are derived per-card via
 * `deriveColumn(arc.sessions, arc.status)`.
 *
 * Renders a header (name + count + collapse toggle) plus a horizontally
 * scrollable row of KanbanColumns when expanded. Each column becomes a
 * droppable whose id is `drop:<lane>:<column>` so KanbanBoard's onDragEnd
 * can resolve the target column.
 *
 * Mobile: columns scroll horizontally with snap points and a fixed min-width
 * so the board is always legible regardless of viewport.
 */

import { ChevronDown, ChevronRight } from 'lucide-react'
import { deriveColumn, type KanbanColumn as KanbanColumnId } from '~/lib/arcs'
import type { ArcSummary } from '~/lib/types'
import { KanbanColumn } from './KanbanColumn'

/** Fixed column order, matches `lib/arcs.ts` `KanbanColumn` union. */
const COLUMNS: ReadonlyArray<KanbanColumnId> = [
  'backlog',
  'research',
  'planning',
  'implementation',
  'verify',
  'done',
]

const COLUMN_LABELS: Record<KanbanColumnId, string> = {
  backlog: 'Backlog',
  research: 'Research',
  planning: 'Planning',
  implementation: 'Impl',
  verify: 'Verify',
  done: 'Done',
}

interface KanbanLaneProps {
  name: string
  cards: ArcSummary[]
  collapsed: boolean
  onToggle: () => void
}

export function KanbanLane({ name, cards, collapsed, onToggle }: KanbanLaneProps) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3">
      <button
        type="button"
        className="flex items-center gap-2 text-sm font-medium"
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        <span className="capitalize">{name}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {cards.length}
        </span>
      </button>
      {collapsed ? null : (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2 snap-x snap-mandatory md:snap-none">
          {COLUMNS.map((col) => {
            const colCards = cards.filter((arc) => deriveColumn(arc.sessions, arc.status) === col)
            return (
              <KanbanColumn
                key={col}
                title={COLUMN_LABELS[col]}
                cards={colCards}
                dropId={`drop:${name}:${col}`}
                isBacklog={col === 'backlog'}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}
