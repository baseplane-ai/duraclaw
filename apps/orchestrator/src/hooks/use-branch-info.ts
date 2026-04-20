/**
 * useBranchInfo — reactive per-turn branch summary.
 *
 * Reads from the per-session `branchInfoCollection` (DO-authored, OPFS-
 * persisted). Returns null when the row is absent — either because the
 * first on-connect snapshot hasn't landed yet, or because this user turn
 * has no siblings (DO only emits rows for turns with ≥ 2 siblings).
 *
 * See GH#14 B7.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { type BranchInfoRow, createBranchInfoCollection } from '~/db/branch-info-collection'

export interface BranchInfoSummary {
  /** 1-indexed position of `activeId` within `siblings`. */
  current: number
  total: number
  siblings: string[]
  activeId: string
}

export function useBranchInfo(agentName: string, parentMsgId: string): BranchInfoSummary | null {
  const collection = useMemo(() => createBranchInfoCollection(agentName), [agentName])

  const { data } = useLiveQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q) => q.from({ rows: collection as any }),
    [collection],
  )

  return useMemo(() => {
    if (!data) return null
    const rows = data as unknown as BranchInfoRow[]
    const row = rows.find((r) => r.parentMsgId === parentMsgId)
    if (!row) return null
    const idx = row.siblings.indexOf(row.activeId)
    return {
      current: idx >= 0 ? idx + 1 : 1,
      total: row.siblings.length,
      siblings: row.siblings,
      activeId: row.activeId,
    }
  }, [data, parentMsgId])
}
