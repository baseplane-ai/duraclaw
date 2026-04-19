/**
 * Hook for reading cached messages from the per-session messages collection.
 *
 * Returns messages for the given `sessionId`, sorted into stable turn order.
 * The collection is produced by `createMessagesCollection(sessionId)` and
 * memoised per agentName — no sessionId filter needed because the collection
 * is already scoped.
 *
 * Sort contract (primary → tiebreaker):
 *   1. User-turn rows with a `canonical_turn_id` (`usr-N`) sort by N — the
 *      SessionDO's strictly-monotonic `turnCounter`. This drives every
 *      reconciled user turn into a stable monotonic slot.
 *   2. Every other row (assistant, tool, optimistic user rows whose echo
 *      has not yet arrived, streaming partials) sorts by `createdAt` at
 *      the tail. Assistant rows anchored to turn N interleave between
 *      turn N and turn N+1 because their `createdAt` falls in that window.
 *
 * The canonical-id-driven sort (B5/B6) gives every reconciled user turn a
 * stable monotonic slot without client-side ordering hints. See GH#14.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'

function parseTurnOrdinal(id?: string): number | undefined {
  if (!id) return undefined
  const m = /^usr-(\d+)$/.exec(id)
  return m ? Number.parseInt(m[1], 10) : undefined
}

function createdAtMs(row: CachedMessage): number {
  if (!row.createdAt) return 0
  return typeof row.createdAt === 'string'
    ? new Date(row.createdAt).getTime()
    : row.createdAt.getTime()
}

/**
 * Returns [primary, secondary] sort tuple. Lower values sort first. Rows
 * with `canonical_turn_id = usr-N` pin to `[N, 0]`; everything else falls
 * through to `[Infinity, createdAt]` so assistant/tool/optimistic rows
 * interleave naturally by server-assigned createdAt.
 */
function sortKey(row: CachedMessage): [number, number] {
  const ord = parseTurnOrdinal(row.canonical_turn_id)
  if (ord !== undefined) return [ord, 0]
  return [Number.POSITIVE_INFINITY, createdAtMs(row)]
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
