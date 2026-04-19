/**
 * Hook for reading cached messages from the per-session messages collection.
 *
 * Returns messages for the given `sessionId`, sorted into stable turn order.
 * The collection is produced by `createMessagesCollection(sessionId)` and
 * memoised per agentName — no sessionId filter needed because the collection
 * is already scoped.
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
 *
 * The P2 migration keeps the sort logic UNCHANGED (still keyed on
 * `usr-optimistic-*` / `turnHint`). Simplification happens in P3 alongside
 * the `createTransaction` rewrite.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'

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
 * turn rows use finite primaries; optimistic rows use their frozen
 * `turnHint` (falling back to MAX_SAFE_INTEGER for legacy rows without
 * one); unknown id formats use MAX_SAFE_INTEGER + createdAt.
 */
function sortKey(row: CachedMessage): [number, number] {
  const turnMatch = TURN_ID_RE.exec(row.id)
  if (turnMatch) {
    return [Number.parseInt(turnMatch[1], 10), 0]
  }
  const optimisticMatch = OPTIMISTIC_ID_RE.exec(row.id)
  if (optimisticMatch) {
    // When turnHint is set (frozen at insert time to maxServerTurn + 1),
    // sort at [turnHint, 0.5] so the optimistic row lands after any
    // server-assigned row with the same turn but before the next turn.
    // This prevents assistant messages (turn N+1) from rendering above
    // the optimistic user message (turn N).
    if (row.turnHint != null) {
      return [row.turnHint, 0.5]
    }
    return [Number.MAX_SAFE_INTEGER, Number.parseInt(optimisticMatch[1], 10)]
  }
  return [Number.MAX_SAFE_INTEGER, createdAtMs(row)]
}

export function useMessagesCollection(sessionId: string) {
  const collection = useMemo(() => createMessagesCollection(sessionId), [sessionId])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(
    (q) => q.from({ messages: collection as any }),
    [collection],
  )

  const messages = useMemo(() => {
    if (!data) return []
    return (data as unknown as CachedMessage[]).slice().sort((a, b) => {
      const [aP, aS] = sortKey(a)
      const [bP, bS] = sortKey(b)
      if (aP !== bP) return aP - bP
      return aS - bS
    })
  }, [data])

  // `isFetching` mirrors queryCollection's fetch state (true while the queryFn
  // is running, including during the retry window). Components derive
  // `isConnecting = isFetching || wsReadyState !== 1`.
  const utils = (collection as unknown as { utils?: { isFetching?: boolean } }).utils
  const isFetching = utils?.isFetching ?? false

  return { messages, isLoading, isFetching }
}
