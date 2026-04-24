import { timingSafeEqual } from 'node:crypto'

import type {
  RateLimitEvent,
  SessionMessageMetadata,
  SyncedCollectionOp,
  SessionMessage as WireSessionMessage,
} from '@duraclaw/shared-types'
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
 * `SessionDO.handleGatewayEvent`'s default branch.
 *
 * Extracted as a pure constant so the predicate is unit-testable without
 * importing SessionDO (the class uses TC39 decorators that vitest/oxc
 * cannot parse).
 */
export const LEGACY_DROPPED_EVENT_TYPES = ['heartbeat', 'session_state_changed'] as const
export type LegacyDroppedEventType = (typeof LEGACY_DROPPED_EVENT_TYPES)[number]

export type PendingGateType = 'ask_user' | 'permission_request'

/**
 * Walk message history newest-first looking for a still-pending gate part
 * whose `toolCallId` matches `gateId`. This is the sole gate lookup used
 * by `SessionDO.resolveGate` — no scalar involved.
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

/**
 * GH#75 P1.2 B7: source-ordering invariant for the `result` event handler.
 *
 * The handler must emit every final-turn `broadcastMessage` frame BEFORE it
 * transitions state to `idle` and BEFORE it flushes status to D1. Client
 * derived-status (spec #31) folds over `messagesCollection`, so if the
 * `updateState({status:'idle'})` lands first the top-level mirror can flip
 * the sidebar to idle while the final assistant turn is still in flight
 * and get overwritten back to the pre-result message on arrival.
 *
 * This helper encodes the invariant by construction: callers pass an
 * ordered "broadcast phase" callback plus the "flush phase" callbacks,
 * and we dispatch them in the order the wire contract requires. The
 * real `handleGatewayEvent('result', …)` branch invokes this helper;
 * tests spy on the callbacks and assert the call log.
 *
 * NOTE: all callbacks are invoked synchronously in the listed order.
 * The helper does NOT await any returned promises — the D1 sync fns are
 * fire-and-forget in the real handler and we preserve that behavior.
 */
export interface FinalizeResultTurnCallbacks {
  /** Emit every per-message frame for the completed turn (orphan finalize,
   * error system message, result-text append). May call `broadcastMessage`
   * zero or more times internally. */
  broadcastPhase: () => void
  /** Transition DO state to `idle` with the result summary fields. */
  updateStateIdle: () => void
  /** Fire-and-forget D1 sync of the `agent_sessions` row. */
  syncStatusToD1: () => void
  /** Fire-and-forget D1 sync of the result columns. */
  syncResultToD1: () => void
}

export function finalizeResultTurn(cbs: FinalizeResultTurnCallbacks): void {
  cbs.broadcastPhase()
  cbs.updateStateIdle()
  cbs.syncStatusToD1()
  cbs.syncResultToD1()
}

// ── Spec #80: awaiting-response helpers ────────────────────────────────

/**
 * Grace window applied to `awaiting_response@pending` parts before the
 * DO watchdog treats them as a stalled dial-out. Mirrors the existing
 * `recoverFromDroppedConnection` grace.
 */
export const RECOVERY_GRACE_MS = 15_000

/**
 * Pure version of `SessionDO.clearAwaitingResponse` (#80 B5).
 *
 * Scans history tail-first for the most-recent user message. If that
 * message's trailing part is `awaiting_response@pending`, returns a new
 * message value with that part stripped. Idempotent — returns `null`
 * when the tail user has no such part (already cleared or never
 * stamped), or when no user message exists in history.
 *
 * Extracted so unit tests can exercise the scan + strip logic without
 * the TC39-decorated SessionDO class.
 */
export function planClearAwaiting<TMsg extends SessionMessage>(
  history: readonly TMsg[],
): { updated: TMsg } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    if (msg.role !== 'user') continue
    const lastPart = msg.parts[msg.parts.length - 1] as
      | { type?: string; state?: string }
      | undefined
    if (lastPart?.type === 'awaiting_response' && lastPart.state === 'pending') {
      const nextParts = msg.parts.slice(0, -1)
      return { updated: { ...msg, parts: nextParts } }
    }
    // Tail user examined (awaiting present or not) — stop scanning.
    return null
  }
  return null
}

/**
 * Pure decision returned by {@link planAwaitingTimeout}.
 *
 * - `{ kind: 'noop' }` — nothing to do (no awaiting tail, runner
 *   attached, or the grace window has not elapsed).
 * - `{ kind: 'expire', startedTs }` — the caller should run the
 *   expire sequence: clear awaiting, append an error system message,
 *   flip DO state to `idle` with the error text populated, and sync
 *   status to D1.
 */
export type AwaitingTimeoutDecision = { kind: 'noop' } | { kind: 'expire'; startedTs: number }

/**
 * Pure version of `SessionDO.checkAwaitingTimeout` (#80 B7).
 *
 * Decides whether the watchdog should expire an awaiting_response part.
 * The decision is a pure function of the current history tail, the
 * runner connection id, the current clock, and the grace window; the
 * caller performs the state mutations so the side-effecting pieces
 * (safeAppendMessage / updateState / syncStatusToD1) stay in the DO.
 */
export function planAwaitingTimeout<TMsg extends SessionMessage>(input: {
  history: readonly TMsg[]
  connectionId: string | null
  now: number
  graceMs?: number
}): AwaitingTimeoutDecision {
  if (input.connectionId !== null) return { kind: 'noop' }
  const grace = input.graceMs ?? RECOVERY_GRACE_MS

  for (let i = input.history.length - 1; i >= 0; i--) {
    const msg = input.history[i]
    if (msg.role !== 'user') continue
    const lastPart = msg.parts[msg.parts.length - 1] as
      | { type?: string; state?: string; startedTs?: number }
      | undefined
    if (lastPart?.type !== 'awaiting_response' || lastPart.state !== 'pending') {
      return { kind: 'noop' }
    }
    const startedTs = typeof lastPart.startedTs === 'number' ? lastPart.startedTs : 0
    if (input.now - startedTs <= grace) return { kind: 'noop' }
    return { kind: 'expire', startedTs }
  }
  return { kind: 'noop' }
}

// ── GH#92 P3: rate_limit & forkWithHistory pure helpers ────────────

/** Slop applied after a successful caam rotation before resuming. */
export const ROTATION_RESUME_SLOP_MS = 1_000

/** Slop applied after the cooldown clears for `rate_limited_no_profile`. */
export const WAITING_PROFILE_RESUME_SLOP_MS = 30_000

/** Fallback when the runner emits `rate_limited_no_profile` without a usable
 *  `earliest_clear_ts` (missing or already past). Matches the inline default
 *  the DO previously hard-coded so behaviour is preserved across the refactor. */
export const NO_PROFILE_FALLBACK_DELAY_MS = 60_000

/**
 * Plan returned by {@link planRateLimitAction}. Each variant captures
 * everything the SessionDO needs to side-effect:
 *
 *  - `breadcrumb` → call `insertSystemBreadcrumb({ body, metadata })`
 *  - `pendingResume` → call `updateState({ pendingResume })` and
 *    `scheduleResumeAlarm(at)`
 *  - `terminalError` → flip status to 'error' with this message and clear
 *    `active_callback_token`
 *  - `degraded` (no exit_reason) → no breadcrumb / no pendingResume — the
 *    raw broadcast that always runs covers B7 dev-box compat.
 */
export type RateLimitPlan =
  | {
      kind: 'rotated'
      breadcrumb: { body: string; metadata: SessionMessageMetadata }
      pendingResume: { kind: 'rotation'; at: number }
    }
  | {
      kind: 'skipped'
      breadcrumb: { body: string; metadata: SessionMessageMetadata }
      terminalError: string
    }
  | {
      kind: 'waiting'
      breadcrumb: { body: string; metadata: SessionMessageMetadata }
      pendingResume: { kind: 'rotation'; at: number }
      earliestClearTs: number
      /** True when the runner-supplied earliest_clear_ts was missing or
       *  already in the past at decision time and the helper substituted
       *  `now + NO_PROFILE_FALLBACK_DELAY_MS`. The DO logs a warning in
       *  this case to surface the runner-side bug. */
      fallbackUsed: boolean
    }
  | {
      kind: 'rotation_missing'
      /** Diagnostic — the DO logs a warning. No side effects beyond the
       *  raw broadcast that always runs. */
    }
  | { kind: 'degraded' }

/**
 * Pure decision function for the rate_limit handler. Maps a
 * RateLimitEvent + current clock to a {@link RateLimitPlan} the
 * SessionDO then executes.
 *
 * GH#92 P3 B4/B5/B6 — branches:
 *   - `exit_reason === 'rate_limited'` + non-null rotation → `rotated`,
 *     resume at `now + ROTATION_RESUME_SLOP_MS`.
 *   - `exit_reason === 'rate_limited'` + null rotation → `rotation_missing`
 *     (the runner shouldn't emit this; DO logs and falls through).
 *   - `exit_reason === 'rate_limited_no_rotate'` → `skipped` + terminal
 *     error.
 *   - `exit_reason === 'rate_limited_no_profile'` → `waiting`, resume at
 *     `earliest_clear_ts + WAITING_PROFILE_RESUME_SLOP_MS`. Falls back to
 *     `now + NO_PROFILE_FALLBACK_DELAY_MS` when the input is missing or
 *     already past (with `fallbackUsed: true`).
 *   - no `exit_reason` → `degraded` (B7 dev-box / legacy relay path).
 */
export function planRateLimitAction(input: { event: RateLimitEvent; now: number }): RateLimitPlan {
  const { event, now } = input
  const exitReason = event.exit_reason

  if (exitReason === 'rate_limited') {
    const rotation = event.rotation
    if (!rotation) {
      return { kind: 'rotation_missing' }
    }
    return {
      kind: 'rotated',
      breadcrumb: {
        body: `⚡ Claude profile rotated ${rotation.from} → ${rotation.to}, resuming…`,
        metadata: {
          caam: { kind: 'rotated', from: rotation.from, to: rotation.to, at: now },
        },
      },
      pendingResume: { kind: 'rotation', at: now + ROTATION_RESUME_SLOP_MS },
    }
  }

  if (exitReason === 'rate_limited_no_rotate') {
    return {
      kind: 'skipped',
      breadcrumb: {
        body: 'Rate-limited and another Claude session is active — not rotating. Retry manually when the other session completes.',
        metadata: { caam: { kind: 'skipped', at: now } },
      },
      terminalError: 'Rate-limited; rotation skipped (peer runner live)',
    }
  }

  if (exitReason === 'rate_limited_no_profile') {
    let earliestClearTs = event.earliest_clear_ts
    let fallbackUsed = false
    if (!earliestClearTs || earliestClearTs <= now) {
      earliestClearTs = now + NO_PROFILE_FALLBACK_DELAY_MS
      fallbackUsed = true
    }
    return {
      kind: 'waiting',
      breadcrumb: {
        body: `All Claude profiles are cooling down — waiting until ${new Date(earliestClearTs).toISOString()} to resume.`,
        metadata: {
          caam: { kind: 'waiting', at: now, earliest_clear_ts: earliestClearTs },
        },
      },
      pendingResume: {
        kind: 'rotation',
        at: earliestClearTs + WAITING_PROFILE_RESUME_SLOP_MS,
      },
      earliestClearTs,
      fallbackUsed,
    }
  }

  return { kind: 'degraded' }
}

/**
 * Plan returned by {@link planPendingResumeDispatch}. The DO uses this
 * to decide what to do at the start of `alarm()` — one of:
 *
 *  - `noop` → not yet due (or no pendingResume); fall through to watchdog
 *  - `dispatch` → pendingResume is due AND no runner is attached AND we
 *    have an sdk_session_id + project; clear pendingResume and trigger
 *    `triggerGatewayDial({type:'resume', ...})`
 *  - `clear_only` → pendingResume is due but a runner is already attached
 *    (the runner reconnected on its own); just drop pendingResume so a
 *    later alarm doesn't dispatch a stale resume
 *  - `clear_missing_context` → pendingResume is due, no runner attached,
 *    but sdk_session_id / project is null; clear and warn (the dispatch
 *    site logs).
 */
export type PendingResumePlan =
  | { kind: 'noop' }
  | {
      kind: 'dispatch'
      sdkSessionId: string
      project: string
    }
  | { kind: 'clear_only' }
  | { kind: 'clear_missing_context' }

export function planPendingResumeDispatch(input: {
  pendingResume: { kind: 'rotation'; at: number } | null | undefined
  now: number
  hasRunner: boolean
  sdkSessionId: string | null
  project: string | null
}): PendingResumePlan {
  const pr = input.pendingResume
  if (!pr || input.now < pr.at) {
    return { kind: 'noop' }
  }
  if (input.hasRunner) {
    return { kind: 'clear_only' }
  }
  if (!input.sdkSessionId || !input.project) {
    return { kind: 'clear_missing_context' }
  }
  return { kind: 'dispatch', sdkSessionId: input.sdkSessionId, project: input.project }
}

/**
 * Build the `<prior_conversation>` SDK resume-prompt prefix from a
 * SessionMessage history. GH#92 P3: drops system-role caam breadcrumbs
 * (rows whose `metadata.caam !== undefined`) so the SDK doesn't see its
 * own chrome replayed as conversation turns; they still ride
 * messagesCollection for the UI.
 *
 * Returns the empty string when no displayable turns survive the filter
 * — caller uses that to decide whether to emit the `<prior_conversation>`
 * wrapper or send the new prompt as-is.
 */
/**
 * Local narrowing shape for the wire-level `parts: unknown[]` array.
 * `WireSessionMessage.parts` is intentionally `unknown[]` on the wire
 * (see `packages/shared-types/src/index.ts`); this alias documents the
 * subset of fields the serializer reads and lets callers see the duck-
 * typed contract without re-asserting on every access.
 */
type MessagePart = {
  type?: string
  text?: string
  toolName?: string
}

export function serializeHistoryForFork(history: readonly WireSessionMessage[]): string {
  const filtered = history.filter((m) => m.metadata?.caam === undefined)
  return filtered
    .map((m) => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role
      const text = m.parts
        .map((rawPart) => {
          const p = rawPart as MessagePart
          if (p.type === 'text') return p.text ?? ''
          if (p.type === 'reasoning') return `[thinking] ${p.text ?? ''}`
          if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
            const name = p.toolName ?? p.type.slice(5)
            return `[used tool: ${name}]`
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return text ? `${role}: ${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}
