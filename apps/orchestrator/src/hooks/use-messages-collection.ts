/**
 * Hook for reading cached messages from the per-session messages collection.
 *
 * Returns messages for the given `sessionId`, sorted into stable turn order.
 * The collection is produced by `createMessagesCollection(sessionId)` and
 * memoised per sessionId — no sessionId filter needed because the collection
 * is already scoped.
 *
 * Sort contract — 2-level tuple `[turnOrdinal, createdAt]`, both ascending,
 * lower values first (GH#38 P1.3 — seq was dropped in B6):
 *
 *   1. Primary: `canonical_turn_id` parsed as `usr-N` (the SessionDO's
 *      strictly-monotonic `turnCounter`), falling back to the message `id`
 *      itself (`usr-N`, `msg-N`, `err-N`). This ensures assistant rows
 *      (`msg-N`) sort alongside their user turn (`usr-N`). Rows without any
 *      parseable ordinal (e.g. optimistic `usr-client-<uuid>` pre-echo)
 *      fall through to `Number.POSITIVE_INFINITY` — they briefly sort last
 *      (below every echoed row) and snap into place once the server echo
 *      arrives with the canonical `usr-N` id.
 *   2. Tertiary: `createdAt` — tie-breaker for rows with the same
 *      turnOrdinal (cold-start REST-loaded rows share ordinal with their
 *      server-side siblings and naturally fall through to createdAt).
 *
 * See GH#14 for the canonical-id history and GH#38 for the seq removal.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'

function parseTurnOrdinal(id?: string): number | undefined {
  if (!id) return undefined
  const m = /^(?:usr|msg|err)-(\d+)$/.exec(id)
  return m ? Number.parseInt(m[1], 10) : undefined
}

function createdAtMs(row: CachedMessage): number {
  if (!row.createdAt) return 0
  return typeof row.createdAt === 'string'
    ? new Date(row.createdAt).getTime()
    : row.createdAt.getTime()
}

/**
 * Returns `[turnOrdinal, createdAt]`. Lower values sort first. Rows without
 * any parseable ordinal (`usr-client-<uuid>` optimistic rows pre-echo) fall
 * back to `Number.POSITIVE_INFINITY` — they briefly sort last, then snap
 * into place when the server echo reconciles with the canonical `usr-N`.
 */
function sortKey(row: CachedMessage): [number, number] {
  const ord =
    parseTurnOrdinal(row.canonical_turn_id) ?? parseTurnOrdinal(row.id) ?? Number.POSITIVE_INFINITY
  return [ord, createdAtMs(row)]
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
      const [aO, aC] = sortKey(a)
      const [bO, bC] = sortKey(b)
      if (aO !== bO) return aO - bO
      return aC - bC
    })
  }, [data])

  // `isFetching` mirrors queryCollection's fetch state (true while the queryFn
  // is running, including during the retry window). Components derive
  // `isConnecting = isFetching || wsReadyState !== 1`.
  const utils = (collection as unknown as { utils?: { isFetching?: boolean } }).utils
  const isFetching = utils?.isFetching ?? false

  return { messages, isLoading, isFetching }
}
