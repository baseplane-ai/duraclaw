/**
 * KanbanBoard — top-level surface for `/board` (P3 U2).
 *
 * Read-only scaffolding. Drag-to-advance, Start-next gating, Backlog new-
 * card form, and PR artifact chips all land in P3 U3.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { chainsCollection } from '~/db/chains-collection'
import { useKanbanLanes } from '~/hooks/use-kanban-lanes'
import type { ChainSummary } from '~/lib/types'
import { KanbanLane } from './KanbanLane'

/** Fixed lane order. Anything not matching falls into 'other'. */
const LANES: ReadonlyArray<'enhancement' | 'bug' | 'other'> = ['enhancement', 'bug', 'other']

function laneFor(chain: ChainSummary): 'enhancement' | 'bug' | 'other' {
  if (chain.issueType === 'enhancement') return 'enhancement'
  if (chain.issueType === 'bug') return 'bug'
  return 'other'
}

export function KanbanBoard() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(chainsCollection as any)
  const { isCollapsed, toggle } = useKanbanLanes()

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

  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Board</h1>
      </Header>
      <Main fluid>
        <div className="flex flex-col gap-3">
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
      </Main>
    </>
  )
}
