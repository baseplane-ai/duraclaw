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
 *
 * Reactivity: subscribes to the collection's `subscribeChanges` callback
 * via `useSyncExternalStore`. This fires on every `.insert()`, `.update()`,
 * and `.delete()` — including bare mutations from the WS delta handler,
 * which the `useLiveQuery` + `q.from()` IVM pipeline was silently dropping
 * (causing deltas to apply to the collection but not re-render the UI).
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
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

/** Extract all rows from a collection (which is Iterable<[key, value]>). */
function collectRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  collection: any,
): CachedMessage[] {
  const rows: CachedMessage[] = []
  try {
    for (const [, row] of collection as Iterable<[string, CachedMessage]>) {
      rows.push(row)
    }
  } catch {
    // Collection may not be iterable yet (queryFn hasn't resolved).
  }
  return rows
}

export function useMessagesCollection(sessionId: string) {
  const collection = useMemo(() => createMessagesCollection(sessionId), [sessionId])

  // Stable snapshot ref — only rebuilt when subscribeChanges fires.
  const snapshotRef = useRef<CachedMessage[]>([])
  const initializedRef = useRef(false)

  // Capture initial state once (before any subscription fires).
  if (!initializedRef.current) {
    snapshotRef.current = collectRows(collection)
    initializedRef.current = true
  }

  // Subscribe to the collection's change notifications directly.
  // This fires on every .insert(), .update(), .delete() — including bare
  // mutations from the WS delta handler that the IVM pipeline was missing.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coll = collection as any
      if (typeof coll.subscribeChanges === 'function') {
        return coll.subscribeChanges(() => {
          snapshotRef.current = collectRows(collection)
          onStoreChange()
        })
      }
      // Fallback: no subscription available.
      return () => {}
    },
    [collection],
  )

  // getSnapshot must return a referentially stable value to avoid infinite
  // re-render loops in useSyncExternalStore. snapshotRef.current is only
  // replaced in subscribeChanges or at initialization.
  const getSnapshot = useCallback(() => snapshotRef.current, [])

  const rawMessages = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const messages = useMemo(() => {
    return rawMessages.slice().sort((a, b) => {
      const [aP, aS] = sortKey(a)
      const [bP, bS] = sortKey(b)
      if (aP !== bP) return aP - bP
      return aS - bS
    })
  }, [rawMessages])

  // `isFetching` mirrors queryCollection's fetch state (true while the queryFn
  // is running, including during the retry window). Components derive
  // `isConnecting = isFetching || wsReadyState !== 1`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const utils = (collection as unknown as { utils?: { isFetching?: boolean } }).utils
  const isFetching = utils?.isFetching ?? false

  return { messages, isLoading: false, isFetching }
}
