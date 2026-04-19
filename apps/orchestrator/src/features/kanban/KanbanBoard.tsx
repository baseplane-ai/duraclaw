/**
 * KanbanBoard — top-level surface for `/board`.
 *
 * P3 U3 adds drag-to-advance: cards become draggables, columns become
 * droppables (`drop:<lane>:<column>`), and onDragEnd runs the B9
 * precondition check + B10 confirmation modal before delegating to
 * advanceChain.
 *
 * Adjacency rule: only strict single-step left-to-right drops are
 * accepted. Any other target is a no-op with a toast.
 */

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useLiveQuery } from '@tanstack/react-db'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { chainsCollection } from '~/db/chains-collection'
import { checkPrecondition } from '~/hooks/use-chain-preconditions'
import { useKanbanLanes } from '~/hooks/use-kanban-lanes'
import type { ChainSummary } from '~/lib/types'
import { AdvanceConfirmModal } from './AdvanceConfirmModal'
import { advanceChain } from './advance-chain'
import { KanbanLane } from './KanbanLane'

/** Fixed lane order. Anything not matching falls into 'other'. */
const LANES: ReadonlyArray<'enhancement' | 'bug' | 'other'> = ['enhancement', 'bug', 'other']

const COLUMN_ORDER: ChainSummary['column'][] = [
  'backlog',
  'research',
  'planning',
  'implementation',
  'verify',
  'done',
]

function laneFor(chain: ChainSummary): 'enhancement' | 'bug' | 'other' {
  if (chain.issueType === 'enhancement') return 'enhancement'
  if (chain.issueType === 'bug') return 'bug'
  return 'other'
}

function parseDropId(id: string): { lane: string; column: ChainSummary['column'] } | null {
  // `drop:<lane>:<column>`
  const parts = id.split(':')
  if (parts.length !== 3 || parts[0] !== 'drop') return null
  const col = parts[2] as ChainSummary['column']
  if (!COLUMN_ORDER.includes(col)) return null
  return { lane: parts[1], column: col }
}

export function KanbanBoard() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(chainsCollection as any)
  const { isCollapsed, toggle } = useKanbanLanes()
  const navigate = useNavigate()

  const chains = useMemo(() => (data ? ([...data] as ChainSummary[]) : []), [data])

  const byLane = useMemo(() => {
    const out: Record<'enhancement' | 'bug' | 'other', ChainSummary[]> = {
      enhancement: [],
      bug: [],
      other: [],
    }
    for (const chain of chains) {
      out[laneFor(chain)].push(chain)
    }
    return out
  }, [chains])

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor))

  // Drag-driven confirmation modal state.
  const [pendingAdvance, setPendingAdvance] = useState<{
    chain: ChainSummary
    nextMode: string
  } | null>(null)
  const [pending, setPending] = useState(false)

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const over = event.over
      const chain = event.active.data.current?.chain as ChainSummary | undefined
      if (!over || !chain) return
      const dest = parseDropId(String(over.id))
      if (!dest) return

      const fromIdx = COLUMN_ORDER.indexOf(chain.column)
      const toIdx = COLUMN_ORDER.indexOf(dest.column)
      if (fromIdx < 0 || toIdx < 0) return
      if (toIdx === fromIdx) return
      if (toIdx < fromIdx) {
        toast.error("Can't move backwards")
        return
      }
      if (toIdx !== fromIdx + 1) {
        toast.error("Can't move to non-adjacent column")
        return
      }

      // Share the session fetch with use-chain-preconditions by reading
      // chain.sessions directly (the collection's filter-by-kataIssue is
      // a superset of chain.sessions). ChainSummary.sessions already
      // carries kataMode + status, which is all checkPrecondition needs
      // for the mode-based gates.
      const sessionsForChain = chain.sessions
      const res = await checkPrecondition(chain, sessionsForChain)
      if (!res.canAdvance || !res.nextMode) {
        toast.error(res.reason || 'Precondition not met')
        return
      }
      setPendingAdvance({ chain, nextMode: res.nextMode })
    },
    [],
  )

  const handleConfirm = useCallback(async () => {
    if (!pendingAdvance) return
    setPending(true)
    const { chain, nextMode } = pendingAdvance
    const res = await advanceChain(chain, nextMode)
    setPending(false)
    setPendingAdvance(null)
    if (!res.ok) {
      toast.error(res.error ?? 'Failed to advance chain')
      return
    }
    toast.success(`Started ${nextMode} for #${chain.issueNumber}`)
    navigate({
      to: '/chain/$issueNumber',
      params: { issueNumber: String(chain.issueNumber) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }, [pendingAdvance, navigate])

  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Board</h1>
      </Header>
      <Main fluid fixed>
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
            {isLoading && chains.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading chains…</p>
            ) : null}
            {LANES.map((lane) => (
              <KanbanLane
                key={lane}
                name={lane}
                cards={byLane[lane]}
                collapsed={isCollapsed(lane)}
                onToggle={() => toggle(lane)}
              />
            ))}
          </div>
        </DndContext>
        {pendingAdvance ? (
          <AdvanceConfirmModal
            open={true}
            onOpenChange={(open) => {
              if (!open) setPendingAdvance(null)
            }}
            issueNumber={pendingAdvance.chain.issueNumber}
            currentMode={pendingAdvance.chain.column}
            nextMode={pendingAdvance.nextMode}
            worktree={pendingAdvance.chain.worktreeReservation?.worktree ?? null}
            worktreeReserved={!!pendingAdvance.chain.worktreeReservation}
            onConfirm={handleConfirm}
            pending={pending}
          />
        ) : null}
      </Main>
    </>
  )
}
