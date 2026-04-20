/**
 * Hook for reading cached messages from the per-session messages collection.
 *
 * Returns messages for the given `sessionId`, sorted into stable turn order.
 * The collection is produced by `createMessagesCollection(sessionId)` and
 * memoised per agentName — no sessionId filter needed because the collection
 * is already scoped.
 *
 * Sort contract — 3-level tuple `[seq, turnOrdinal, createdAt]`, all
 * ascending, lower values first (spec-31 P4a B8):
 *
 *   1. Primary: wire `seq` stamped at apply time in `use-coding-agent.ts`
 *      (`frame.seq` for deltas, `frame.payload.version` for snapshots).
 *      Rows without a seq (optimistic `usr-client-<uuid>` rows pre-echo,
 *      cold-start rows from the REST queryFn, and pre-P4a cached rows
 *      loaded after the schemaVersion 5 migration) fall back to
 *      `Number.POSITIVE_INFINITY` — i.e. sort AFTER every stamped row.
 *      That gives optimistic rows the "briefly appears below not-yet-
 *      echoed rows, then snaps into place on echo" behaviour from spec.
 *   2. Secondary: `canonical_turn_id` parsed as `usr-N` (the SessionDO's
 *      strictly-monotonic `turnCounter`), falling back to the message `id`
 *      itself (`usr-N`, `msg-N`, `err-N`). This ensures assistant rows
 *      (`msg-N`) sort alongside their user turn (`usr-N`) even when `seq`
 *      is absent (REST-loaded messages). Rows without any parseable
 *      ordinal fall through.
 *   3. Tertiary: `createdAt` — tie-breaker for rows with the same seq and
 *      no / equal turnOrdinal (snapshot rows all share their frame's
 *      version, so they tie on seq and fall through to turnOrdinal /
 *      createdAt, which is their already-ordered-at-emit-time).
 *
 * See GH#14 for the canonical-id history and spec 31 for the seq layer.
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
 * Returns `[seq, turnOrdinal, createdAt]`. Lower values sort first. Rows
 * missing `seq` sort after every stamped row (by `Number.POSITIVE_INFINITY`)
 * — that covers optimistic rows, cold-start queryFn rows, and pre-P4a
 * cached rows.
 */
function sortKey(row: CachedMessage): [number, number, number] {
  const seq = row.seq ?? Number.POSITIVE_INFINITY
  const ord =
    parseTurnOrdinal(row.canonical_turn_id) ??
    parseTurnOrdinal(row.id) ??
    Number.POSITIVE_INFINITY
  return [seq, ord, createdAtMs(row)]
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
      const [aS, aO, aC] = sortKey(a)
      const [bS, bO, bC] = sortKey(b)
      if (aS !== bS) return aS - bS
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
