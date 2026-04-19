/**
 * Hook for reading cached messages from the local messages collection.
 *
 * Returns messages filtered by sessionId, sorted into stable turn order.
 *
 * Sort contract (primary → tiebreaker):
 *   1. Server-assigned rows (`usr-N` / `msg-N` / `err-N`) sort by N, which is
 *      the SessionDO's strictly-monotonic `turnCounter`. This is the only
 *      source of truth for chronological order — client `createdAt` can
 *      differ from server `createdAt` for the same logical message (clock
 *      skew), and timestamps can tie on rapid bursts.
 *   2. Optimistic rows (`usr-optimistic-<ms>`) sort AFTER every server row,
 *      in FIFO order by the timestamp embedded in the id. Until the server
 *      echo arrives they belong at the tail of the thread; once the echo
 *      lands and `clearOldestOptimisticRow` trims one, the real `usr-N`
 *      falls into its proper turn-N slot.
 *   3. Unknown id formats fall back to `createdAt` as a last-resort
 *      tiebreaker so forward-compat rows still render in something sensible.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { type CachedMessage, messagesCollection } from '~/db/messages-collection'

const TURN_ID_RE = /^(?:usr|msg|err)-(\d+)$/
const OPTIMISTIC_ID_RE = /^usr-optimistic-(\d+)$/

function createdAtMs(row: CachedMessage): number {
  if (!row.createdAt) return 0
  return typeof row.createdAt === 'string'
    ? new Date(row.createdAt).getTime()
    : row.createdAt.getTime()
}

/**
 * Returns [primary, secondary] sort tuple. Lower values sort first. Server
 * turn rows use finite primaries; optimistic + unknown rows use
 * Number.MAX_SAFE_INTEGER so they always trail the server-ordered section.
 */
function sortKey(row: CachedMessage): [number, number] {
  const turnMatch = TURN_ID_RE.exec(row.id)
  if (turnMatch) {
    return [Number.parseInt(turnMatch[1], 10), 0]
  }
  const optimisticMatch = OPTIMISTIC_ID_RE.exec(row.id)
  if (optimisticMatch) {
    return [Number.MAX_SAFE_INTEGER, Number.parseInt(optimisticMatch[1], 10)]
  }
  return [Number.MAX_SAFE_INTEGER, createdAtMs(row)]
}

export function useMessagesCollection(sessionId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery((q) => q.from({ messages: messagesCollection as any }))

  const messages = useMemo(() => {
    if (!data) return []
    return (data as unknown as CachedMessage[])
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => {
        const [aP, aS] = sortKey(a)
        const [bP, bS] = sortKey(b)
        if (aP !== bP) return aP - bP
        return aS - bS
      })
  }, [data, sessionId])

  return { messages, isLoading }
}
