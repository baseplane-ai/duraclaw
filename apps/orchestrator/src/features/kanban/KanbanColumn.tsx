/**
 * KanbanColumn — one phase column inside a lane row.
 *
 * P3 U3: becomes a droppable via `@dnd-kit/core`, plus an inline
 * "Create chain" form on the Backlog column only.
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
        placeholder="Issue #"
        className="h-7 text-[11px]"
        inputMode="numeric"
      />
      <Button type="submit" size="sm" variant="outline" className="h-7 px-2 text-[11px]">
        Create
      </Button>
    </form>
  )
}

export function KanbanColumn({ title, cards, dropId, isBacklog }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col gap-2 rounded-md border border-dashed p-2 ${
        isOver ? 'border-primary bg-primary/5' : 'border-border/60'
      }`}
    >
      <div className="flex items-center justify-between px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        <span>{cards.length}</span>
      </div>
      {isBacklog ? <BacklogNewCardForm /> : null}
      <div className="flex flex-col gap-2">
        {cards.map((chain) => (
          <KanbanCard key={chain.issueNumber} chain={chain} />
        ))}
      </div>
    </div>
  )
}
