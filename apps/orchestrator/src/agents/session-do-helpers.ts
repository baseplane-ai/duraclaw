import { timingSafeEqual } from 'node:crypto'

import type { SyncedCollectionOp } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'

/**
 * Pure op-derivation helper for snapshot emitters (GH#38 P1.4).
 *
 * Given the "old view" history (what the client is currently displaying)
 * and the "new view" history (the authoritative history after the
 * mutation), returns a SyncedCollectionOp array containing:
 *   - `delete` ops for every id present in `oldLeaf` but NOT in `newLeaf`
 *     (the branch-only rows the client must discard)
 *   - `insert` ops for every row in `newLeaf` (authoritative-full; TanStack
 *     DB's key-based upsert dedupes the shared-prefix rows at apply time).
 *
 * Delete ops are emitted first, insert ops second — the wire contract in
 * B9 requires this ordering so the client drops stale rows before upserts
 * can re-introduce an id that happens to collide.
 *
 * Extracted from session-do.ts so unit tests can import without triggering
 * the TC39 decorator parse barrier that blocks direct SessionDO import.
 */
export function deriveSnapshotOps<TRow extends { id: string }>(input: {
  oldLeaf: readonly TRow[]
  newLeaf: readonly TRow[]
}): {
  staleIds: string[]
  ops: SyncedCollectionOp<TRow>[]
} {
  const newIds = new Set(input.newLeaf.map((m) => m.id))
  const staleIds = input.oldLeaf.filter((m) => !newIds.has(m.id)).map((m) => m.id)
  const ops: SyncedCollectionOp<TRow>[] = [
    ...staleIds.map((id) => ({ type: 'delete' as const, key: id })),
    ...input.newLeaf.map((value) => ({ type: 'insert' as const, value })),
  ]
  return { staleIds, ops }
}

/** Minimal tagged-template SQL interface used by extracted helper functions. */
export type SqlFn = <T>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[]

/** Default stale threshold for the DO watchdog (ms). */
export const DEFAULT_STALE_THRESHOLD_MS = 90_000

/**
 * Resolve the stale-threshold used by the DO watchdog alarm. Reads from
 * env.STALE_THRESHOLD_MS when present and parsable as a positive integer;
 * otherwise falls back to {@link DEFAULT_STALE_THRESHOLD_MS}.
 */
export function resolveStaleThresholdMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_STALE_THRESHOLD_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALE_THRESHOLD_MS
  return n
}

/**
 * Constant-time string compare. Returns false if lengths differ (avoids the
 * length-mismatch throw from Node's timingSafeEqual) and otherwise defers to
 * node:crypto's timingSafeEqual over utf-8 bytes.
 *
 * Constant-time string comparison using `crypto.timingSafeEqual`.
 *
 * Returns false immediately when lengths differ, so this helper leaks the
 * EXPECTED length — it does not hide it. Acceptable for fixed-length
 * secrets (UUIDs, hex hashes of known size) because the attacker already
 * knows that length. For variable-length secrets, pad before comparing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/**
 * Load turnCounter and currentTurnMessageId from assistant_config.
 * Must be called AFTER Session table initialization (e.g. getPathLength())
 * to ensure the assistant_config table exists.
 */
export function loadTurnState(
  sql: SqlFn,
  pathLength: number,
): { turnCounter: number; currentTurnMessageId: string | null } {
  let turnCounter = 0
  let currentTurnMessageId: string | null = null

  const configRows = sql<{ value: string }>`
    SELECT value FROM assistant_config WHERE session_id = '' AND key = 'turnCounter'
  `
  if (configRows.length > 0) {
    turnCounter = Number.parseInt(configRows[0].value, 10) || 0
  } else {
    // First use or data loss — seed from path length to avoid ID collisions
    turnCounter = pathLength + 1
  }

  const turnIdRows = sql<{ value: string }>`
    SELECT value FROM assistant_config WHERE session_id = '' AND key = 'currentTurnMessageId'
  `
  if (turnIdRows.length > 0 && turnIdRows[0].value !== '') {
    currentTurnMessageId = turnIdRows[0].value
  }

  return { turnCounter, currentTurnMessageId }
}

/**
 * Validate a gateway token against stored token and TTL.
 * Returns true if the token is valid and not expired, false otherwise.
 * The token is NOT consumed on use — it remains valid until its TTL expires,
 * allowing reconnects to reuse the same callback URL.
 */
export function validateGatewayToken(sql: SqlFn, token: string | null): boolean {
  if (!token) return false
  try {
    const rows = [...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_token'`]
    if (rows.length === 0 || rows[0].value !== token) return false

    // Check TTL
    const expiresRows = [
      ...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_token_expires'`,
    ]
    if (expiresRows.length > 0 && Number(expiresRows[0].value) < Date.now()) {
      // Token expired — clean up
      sql`DELETE FROM kv WHERE key IN ('gateway_token', 'gateway_token_expires')`
      return false
    }

    return true
  } catch {
    return false
  }
}

/** Read the persisted gateway connection ID from SQLite kv table. */
export function getGatewayConnectionId(sql: SqlFn): string | null {
  try {
    const rows = [...sql<{ value: string }>`SELECT value FROM kv WHERE key = 'gateway_conn_id'`]
    return rows.length > 0 ? rows[0].value : null
  } catch {
    return null
  }
}

/**
 * Build the callback URL that the gateway should dial back to.
 * Returns null if required configuration is missing.
 */
export function buildGatewayCallbackUrl(
  workerPublicUrl: string,
  doId: string,
  token: string,
): string {
  const wsScheme = workerPublicUrl.startsWith('https') ? 'wss' : 'ws'
  const wsBase = workerPublicUrl.replace(/^https?:/, `${wsScheme}:`)
  return `${wsBase}/agents/session-agent/${doId}?role=gateway&token=${token}`
}

/**
 * Build the gateway HTTP start URL from a gateway WebSocket URL.
 */
export function buildGatewayStartUrl(gatewayUrl: string): string {
  const httpBase = gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  return `${httpBase}/sessions/start`
}

/** How long a submitId stays in submit_ids before being pruned. */
export const SUBMIT_ID_TTL_MS = 60_000
/** Max allowed length for a submitId. */
export const SUBMIT_ID_MAX_LEN = 64

export type SubmitIdResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: 'invalid submitId' }

/**
 * Validate and claim a submitId for idempotent message submission.
 *
 * - Rejects non-string, empty, or >64 char submitIds with
 *   `{ ok: false, error: 'invalid submitId' }`.
 * - If the submitId already exists in `submit_ids`, returns
 *   `{ ok: true, duplicate: true }` — the caller should short-circuit.
 * - Otherwise inserts the id, prunes rows older than {@link SUBMIT_ID_TTL_MS},
 *   and returns `{ ok: true, duplicate: false }`.
 *
 * Extracted from SessionDO.sendMessage so it can be exercised by unit
 * tests without standing up the full DO (decorators can't be parsed by
 * vitest/oxc).
 */
export function claimSubmitId(
  sql: SqlFn,
  submitId: unknown,
  now: number = Date.now(),
): SubmitIdResult {
  if (
    typeof submitId !== 'string' ||
    submitId.length === 0 ||
    submitId.length > SUBMIT_ID_MAX_LEN
  ) {
    return { ok: false, error: 'invalid submitId' }
  }
  const existing = [
    ...sql<{ id: string }>`SELECT id FROM submit_ids WHERE id = ${submitId} LIMIT 1`,
  ]
  if (existing.length > 0) {
    return { ok: true, duplicate: true }
  }
  sql`INSERT INTO submit_ids (id, created_at) VALUES (${submitId}, ${now})`
  const cutoff = now - SUBMIT_ID_TTL_MS
  sql`DELETE FROM submit_ids WHERE created_at < ${cutoff}`
  return { ok: true, duplicate: false }
}

/**
 * GH#50 B9: legacy event types that pre-B7 session-runners still emit
 * while parked in `waitForNext()`. They are logged-once-then-dropped by
 * `SessionDO.handleGatewayEvent`'s default branch AND — critically —
 * must NOT bump `lastEventTs`. A zombie runner emitting a heartbeat
 * every ~10s would otherwise keep refreshing client-side liveness and
 * defeat the 45s TTL override that is the whole point of GH#50.
 *
 * Extracted as a pure constant so the predicate is unit-testable without
 * importing SessionDO (the class uses TC39 decorators that vitest/oxc
 * cannot parse).
 */
export const LEGACY_DROPPED_EVENT_TYPES = ['heartbeat', 'session_state_changed'] as const
export type LegacyDroppedEventType = (typeof LEGACY_DROPPED_EVENT_TYPES)[number]

/**
 * True when `handleGatewayEvent` should bump `lastEventTs` for the given
 * event. Returns false for legacy frames (see `LEGACY_DROPPED_EVENT_TYPES`)
 * so TTL-derived status on the client can correctly flip a parked zombie
 * runner to `idle` after 45s of silence.
 */
export function shouldBumpLastEventTs(eventType: string): boolean {
  return !(LEGACY_DROPPED_EVENT_TYPES as readonly string[]).includes(eventType)
}

export type PendingGateType = 'ask_user' | 'permission_request'

/**
 * Walk message history newest-first looking for a still-pending gate part
 * whose `toolCallId` matches `gateId`. Used as the fallback in
 * `SessionDO.resolveGate` when the scalar `state.gate.id` has drifted from
 * what the client last rendered (dropped broadcasts, runner reconnect,
 * multiple in-flight gates).
 *
 * Returns `null` when no part with that id exists, or the matching part
 * has already moved past `approval-requested` (output-available /
 * output-denied).
 */
export function findPendingGatePart(
  history: SessionMessage[],
  gateId: string,
): { type: PendingGateType } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    for (const p of msg.parts) {
      if (p.toolCallId !== gateId) continue
      // `tool-AskUserQuestion` / `input-available` is the SDK-native
      // shape before `promoteToolPartToGate` flips it; the client now
      // renders the gate directly off this shape, so a resolve can
      // arrive before the promotion (or if the promotion was
      // silent-dropped on a half-closed socket). Match it too.
      if (
        p.type === 'tool-AskUserQuestion' &&
        (p.state === 'input-available' || p.state === 'approval-requested')
      ) {
        return { type: 'ask_user' }
      }
      if (p.state !== 'approval-requested') continue
      if (p.type === 'tool-ask_user') return { type: 'ask_user' }
      if (p.type === 'tool-permission') return { type: 'permission_request' }
    }
  }
  return null
}
