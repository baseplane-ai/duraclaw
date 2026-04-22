/**
 * GH#50 — client-side TTL predicate for session status.
 *
 * Replaces direct reads of `session.status` in render-layer components.
 * The DO bumps `agent_sessions.last_event_ts` on every GatewayEvent and
 * flushes on lifecycle transitions; this predicate folds that liveness
 * marker over the server-authoritative `status` to override stuck
 * `running` rows after >TTL_MS of silence.
 *
 * Pure / synchronous. Stateless. No imports beyond types.
 *
 * Predicate order (first match wins):
 *   1. `archived === true`     → 'archived'
 *   2. `error != null`         → row.status (terminal — DO already set
 *                                 status to 'idle' along with errorCode,
 *                                 so we trust it here.)
 *   3. `lastEventTs == null`   → row.status (pre-migration fallback —
 *                                 the row predates 0017 / has never
 *                                 received an event under the new code
 *                                 path, so we have no TTL data.)
 *   4. `row.status === 'running'` AND (now - lastEventTs) > TTL_MS
 *                              → 'idle'  (TTL stale override — scoped
 *                                to running only; `waiting_gate` /
 *                                `waiting_input` are expected to be
 *                                quiet while the user is deciding,
 *                                so TTL MUST NOT flip them to idle.)
 *   5. default                 → row.status  (server-authoritative)
 *
 * Boundary: `<= TTL_MS` returns server status; `> TTL_MS` returns idle
 * (only when server status is 'running').
 *
 * Server-side queries (`/api/sessions/active` filter, `history` sort,
 * chain summaries) intentionally still read D1 `status` — see spec
 * Non-Goals. Brief server staleness for sort/filter is acceptable; the
 * user pain is render-layer-only sticky `running`.
 */

import type { SessionStatus } from '~/lib/types'

export const TTL_MS = 45_000

/**
 * Minimum row shape `deriveStatus` needs. Accepts any row whose fields
 * include `status`, `archived`, `error`, and optional `lastEventTs` —
 * `SessionSummary`, `SessionRecord`, and `AgentSessionRow` all satisfy
 * this without an explicit cast at the callsite.
 *
 * We deliberately don't depend on `~/db/schema` here so this module can
 * be imported in pure-render contexts (TanStack Start SSR, vitest) that
 * don't pull in drizzle.
 */
export interface DeriveStatusRow {
  status: string
  archived?: boolean | null
  error?: string | null
  lastEventTs?: number | null
}

/**
 * Returns the effective `SessionStatus` for a session row at the given
 * wall-clock time, applying the GH#50 TTL override.
 *
 * @param row    Session row (anything matching `DeriveStatusRow`).
 * @param nowTs  Current epoch ms — pass from `useNow()` so re-renders
 *               batch on the shared 10s tick rather than per-component.
 *
 * NOTE: callers handle the "session not yet loaded" case with
 *   `session ? deriveStatus(session, nowTs) : undefined`
 * — this function does NOT accept undefined rows.
 */
export function deriveStatus(row: DeriveStatusRow, nowTs: number): SessionStatus {
  if (row.archived) return 'archived' as SessionStatus
  // Terminal / error rows: trust the server. The DO sets status='idle'
  // alongside the error in `syncStatusAndErrorToD1`, so passing through
  // `row.status` here yields the right user-visible label without
  // tripping the TTL override during the post-error quiet period.
  if (row.error != null) return row.status as SessionStatus
  // Pre-migration / never-bumped rows: no TTL data, trust the server.
  if (row.lastEventTs == null) return row.status as SessionStatus
  // TTL-stale override: client doesn't trust the server's `running`
  // beyond TTL_MS of silence. This is the whole point of the spec.
  // SCOPED to 'running' — `waiting_gate` / `waiting_input` are expected
  // to be quiet while the user decides, so applying TTL here would
  // incorrectly hide a pending gate from the UI after 45s.
  if (row.status === 'running' && nowTs - row.lastEventTs > TTL_MS) return 'idle'
  return row.status as SessionStatus
}
