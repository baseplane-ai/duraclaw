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
import { useMemo, useRef } from 'react'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'

// Minimal shape of the trailing part we sniff for the cache signature.
// Avoids importing the full `SessionMessagePart` union (which would drag in
// the orchestrator's `lib/types` barrel) into a file scoped to cache keys.
type SessionMessagePartLike = { text?: unknown }

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

  // GH#55: cache the previous sorted array and reuse its reference when the
  // input rows are shallow-identical. `useLiveQuery` re-emits on every sync
  // event (REST cold-load → WS snapshot burst → WS first delta fire in rapid
  // succession on session mount); without this guard each emission produces
  // a fresh sorted array, which changes Virtuoso's `data` identity and
  // churns its internal bookkeeping on a session switch. Identity check is
  // keyed on length + per-row `[id, parts.length, trailing text length]` —
  // the same signals ChatMessageRow's memo comparator watches.
  const prevSortedRef = useRef<CachedMessage[] | null>(null)
  const prevSignatureRef = useRef<string>('')
  const messages = useMemo(() => {
    if (!data) {
      prevSortedRef.current = null
      prevSignatureRef.current = ''
      return [] as CachedMessage[]
    }
    const sorted = (data as unknown as CachedMessage[]).slice().sort((a, b) => {
      const [aO, aC] = sortKey(a)
      const [bO, bC] = sortKey(b)
      if (aO !== bO) return aO - bO
      return aC - bC
    })
    // Build a compact signature that catches the mutations we render off of:
    // row inserts/removes (length), turn structure (ids in order), parts
    // growth on streaming turns (parts.length), trailing-text growth
    // (trailing part's text length). Cheap to compute, O(n) — far cheaper
    // than re-running Virtuoso's measurement loop on a spurious data-prop
    // change.
    let signature = `${sorted.length}`
    for (const row of sorted) {
      const parts = row.parts as SessionMessagePartLike[] | undefined
      const last = parts && parts.length > 0 ? parts[parts.length - 1] : undefined
      const textLen = typeof last?.text === 'string' ? last.text.length : 0
      signature += `|${row.id}:${parts?.length ?? 0}:${textLen}`
    }
    if (prevSortedRef.current && signature === prevSignatureRef.current) {
      return prevSortedRef.current
    }
    prevSortedRef.current = sorted
    prevSignatureRef.current = signature
    return sorted
  }, [data])

  // `isFetching` mirrors queryCollection's fetch state (true while the queryFn
  // is running, including during the retry window). Components derive
  // `isConnecting = isFetching || wsReadyState !== 1`.
  const utils = (collection as unknown as { utils?: { isFetching?: boolean } }).utils
  const isFetching = utils?.isFetching ?? false

  return { messages, isLoading, isFetching }
}
