/**
 * Hook for reading cached messages from the per-session messages collection.
 *
 * Returns messages for the given `sessionId`, sorted into stable turn order.
 * The collection is produced by `createMessagesCollection(sessionId)` and
 * memoised per sessionId — no sessionId filter needed because the collection
 * is already scoped.
 *
 * Sort contract — 3-level tuple `[turnOrdinal, roleRank, createdAt]`, all
 * ascending, lower values first (GH#38 P1.3 — seq was dropped in B6;
 * roleRank added to guard cross-clock createdAt comparisons within a turn):
 *
 *   1. Primary: `canonical_turn_id` parsed as `usr-N` (the SessionDO's
 *      strictly-monotonic `turnCounter`), falling back to the message `id`
 *      itself (`usr-N`, `msg-N`, `err-N`). This ensures assistant rows
 *      (`msg-N`) sort alongside their user turn (`usr-N`). Rows without any
 *      parseable ordinal (e.g. optimistic `usr-client-<uuid>` pre-echo)
 *      fall through to `Number.POSITIVE_INFINITY` — they briefly sort last
 *      (below every echoed row) and snap into place once the server echo
 *      arrives with the canonical `usr-N` id.
 *   2. Secondary: `roleRank` — within a single turn, user always renders
 *      before assistant before tool/error. This is the causal/logical
 *      ordering (a user can never speak after the assistant within one
 *      turn) and crucially it isolates us from cross-clock createdAt
 *      comparisons: the user's `createdAt` is client wall-clock (preserved
 *      by the server), while the same-turn assistant's `createdAt` is
 *      server wall-clock (stamped on the first partial_assistant). When
 *      client clock skew exceeds user-POST → first-token latency, those
 *      timestamps invert; without roleRank the user bubble would visibly
 *      drop below the streaming assistant midstream.
 *   3. Tertiary: `createdAt` — tie-breaker for rows with the same
 *      turnOrdinal AND same role (cold-start REST-loaded rows share
 *      ordinal with their server-side siblings and naturally fall through
 *      to createdAt).
 *
 * See GH#14 for the canonical-id history and GH#38 for the seq removal.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo, useRef } from 'react'
import { type CachedMessage, createMessagesCollection } from '~/db/messages-collection'

// Minimal shape of parts we sniff for the cache signature. Avoids importing
// the full `SessionMessagePart` union (which would drag in the orchestrator's
// `lib/types` barrel) into a file scoped to cache keys.
//
// `state` is included so in-place part transitions (gate
// `input-available`/`approval-requested` → `output-available`, tool
// `output-available`/`output-error`, text `streaming` → done) invalidate the
// cached sorted array. Without it, the optimistic gate-resolve write in
// use-coding-agent (which mutates only `state` + `output` on a non-trailing
// part) lands in the collection but never reaches the renderer until the
// next message arrives — symptom: "submit feels frozen until first
// assistant message comes back."
//
// `outputPresent` flips when an `output` field appears on a part — covers
// the optimistic gate write that adds the answer alongside the state flip,
// and also generic tool result arrivals where `parts.length` is unchanged.
type SessionMessagePartLike = { text?: unknown; state?: unknown; output?: unknown }

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
 * Within a single turn, user always renders before assistant before
 * tool/error. This guards against cross-clock createdAt inversion (user
 * createdAt is client wall-clock; same-turn assistant createdAt is server
 * wall-clock).
 */
function roleRank(role: string | undefined): number {
  if (role === 'user') return 0
  if (role === 'assistant') return 1
  return 2
}

/**
 * Returns `[turnOrdinal, roleRank, createdAt]`. Lower values sort first.
 * Rows without any parseable ordinal (`usr-client-<uuid>` optimistic rows
 * pre-echo) fall back to `Number.POSITIVE_INFINITY` — they briefly sort
 * last, then snap into place when the server echo reconciles with the
 * canonical `usr-N`.
 */
function sortKey(row: CachedMessage): [number, number, number] {
  const ord =
    parseTurnOrdinal(row.canonical_turn_id) ?? parseTurnOrdinal(row.id) ?? Number.POSITIVE_INFINITY
  return [ord, roleRank(row.role), createdAtMs(row)]
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
      const [aO, aR, aC] = sortKey(a)
      const [bO, bR, bC] = sortKey(b)
      if (aO !== bO) return aO - bO
      if (aR !== bR) return aR - bR
      return aC - bC
    })
    // Build a compact signature that catches the mutations we render off of:
    // row inserts/removes (length), turn structure (ids in order), parts
    // growth on streaming turns (parts.length), trailing-text growth
    // (trailing part's text length), AND per-part state transitions +
    // output-arrival (gate resolve, tool completion). The per-part state
    // hash is what makes optimistic writes that mutate *state only* on a
    // non-trailing part (GateResolver submit) visible to the renderer —
    // without it, the submit-click lands in TanStack DB's optimistic layer
    // but `prevSortedRef.current` is returned because the signature doesn't
    // budge, and the user sees no feedback until the next assistant delta
    // grows `parts.length` or `textLen` and forces a recompute.
    //
    // Still O(parts) per row — same big-O as before, just one extra
    // character per part.
    let signature = `${sorted.length}`
    for (const row of sorted) {
      const parts = row.parts as SessionMessagePartLike[] | undefined
      const last = parts && parts.length > 0 ? parts[parts.length - 1] : undefined
      const textLen = typeof last?.text === 'string' ? last.text.length : 0
      // Per-part state + output-presence, concatenated. Using a single char
      // per part (first letter of state; '+' when output is present, '-'
      // otherwise) keeps the signature compact; mutations always change at
      // least one character.
      let partsHash = ''
      if (parts) {
        for (const p of parts) {
          const s = typeof p.state === 'string' ? p.state : ''
          partsHash += s.length > 0 ? s[0] : '_'
          partsHash += p.output !== undefined ? '+' : '-'
        }
      }
      signature += `|${row.id}:${parts?.length ?? 0}:${textLen}:${partsHash}`
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
