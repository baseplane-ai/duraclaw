/**
 * KanbanColumn — one phase column inside a lane row.
 *
 * Uses a fixed min-width so the parent's horizontal scroll activates on
 * narrow viewports. On desktop the columns flex-grow to fill available space.
 */

import { useDroppable } from '@dnd-kit/core'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import type { ChainSummary } from '~/lib/types'
import { KanbanCard } from './KanbanCard'

interface KanbanColumnProps {
  title: string
  cards: ChainSummary[]
  /** Drop-zone id wired up by KanbanBoard (`drop:<lane>:<column>`). */
  dropId: string
  /** Enables the inline Create chain form at the top of the column. */
  isBacklog?: boolean
}

function BacklogNewCardForm() {
  const navigate = useNavigate()
  const [value, setValue] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = Number(value.trim())
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      toast.error('Enter a positive integer issue number')
      return
    }
    setValue('')
    navigate({
      to: '/chain/$issueNumber',
      params: { issueNumber: String(n) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-1">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="#"
        className="h-8 min-w-0 flex-1 text-xs"
        inputMode="numeric"
      />
      <Button type="submit" size="sm" variant="outline" className="h-8 shrink-0 px-3 text-xs">
        Add
      </Button>
    </form>
  )
}

export function KanbanColumn({ title, cards, dropId, isBacklog }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      className={`flex min-w-[180px] flex-1 shrink-0 snap-start flex-col gap-2 rounded-lg border p-2.5 transition-colors ${
        isOver
          ? 'border-primary bg-primary/5'
          : 'border-border/50 bg-background/50'
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

      {isBacklog ? <BacklogNewCardForm /> : null}

      {/* Card stack */}
      <div className="flex flex-col gap-2">
        {cards.map((chain) => (
          <KanbanCard key={chain.issueNumber} chain={chain} />
        ))}
      </div>
    </div>
  )
}
