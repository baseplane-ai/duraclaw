import type { SyncedCollectionOp } from '@duraclaw/shared-types'
import type { SessionMessage } from 'agents/experimental/memory/session'
import { offloadOversizedImages, sanitizePartsForStorage } from '~/lib/message-parts'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 4 + Stage 6: history.
 *
 * Owns message-history persistence helpers, turn-counter management,
 * snapshot-op derivation, and the submitId idempotency table — all
 * absorbed from the now-deleted `session-do-helpers.ts`. `computeBranchInfo*`
 * lives in `branches.ts` per the spec, NOT here.
 */

/** Minimal tagged-template SQL interface used by free helpers in this module. */
type SqlFn = <T>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[]

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
 * appendMessage with R2 offload for oversized image parts. Lazy-stamps
 * `modified_at = created_at` on the SDK-owned row so the unified
 * `replayMessagesFromCursor` cursor advances past freshly-appended rows
 * (v13 invariant — see migration v13 description).
 */
export async function safeAppendMessage(
  ctx: SessionDOContext,
  msg: SessionMessage,
  parentId?: string | null,
): Promise<void> {
  await offloadOversizedImages(msg.parts, {
    sessionId: ctx.do.name,
    messageId: msg.id,
    r2Bucket: ctx.env.SESSION_MEDIA,
  })
  const result = ctx.session.appendMessage(msg, parentId)
  // v13: seed modified_at = created_at on every new row so the unified
  // modified_at cursor in replayMessagesFromCursor can advance past it.
  // Without this seed, freshly-appended rows sit at modified_at=NULL and
  // the strict `modified_at > cursor` predicate excludes them on warm
  // reconnect — symmetric with the inverse bug (excluded update replay)
  // that motivated v10. Best-effort: pre-v10 DOs silently no-op.
  try {
    ctx.sql.exec(
      `UPDATE assistant_messages SET modified_at = created_at WHERE id = ? AND session_id = '' AND modified_at IS NULL`,
      msg.id,
    )
  } catch {
    // Pre-v10 DO — column does not yet exist. Safe to ignore.
  }
  return result
}

/**
 * updateMessage with pre-write sanitization of oversized image parts and
 * `modified_at` tracking for cursor-based reconnect replay.
 *
 * Images should already be offloaded to R2 by safeAppendMessage; the sync
 * truncation here is a safety net for the rare case an update somehow
 * carries new image data.
 *
 * Without `modified_at`, `replayMessagesFromCursor` (keyset on `created_at`)
 * can never replay an in-place update to a row whose `created_at` is behind
 * the client's cursor — the root cause of the "final assistant text missing
 * until refresh" bug on long tool-heavy turns where the tab was backgrounded
 * during the turn.
 */
export function safeUpdateMessage(ctx: SessionDOContext, msg: SessionMessage): void {
  sanitizePartsForStorage(msg.parts, {
    sessionId: ctx.do.name,
    messageId: msg.id,
  })
  ctx.session.updateMessage(msg)
  try {
    ctx.sql.exec(
      `UPDATE assistant_messages SET modified_at = ? WHERE id = ? AND session_id = ''`,
      new Date().toISOString(),
      msg.id,
    )
  } catch {
    // Best-effort — modified_at is a reconnect hint, not a correctness gate.
    // Fails silently if migration v10 hasn't run on this DO yet.
  }
}

/**
 * Persist the live `turnCounter` and `currentTurnMessageId` to the SDK's
 * `assistant_config` table so a DO rehydrate after eviction restarts at the
 * right ordinal instead of colliding canonical IDs (GH#14 P3).
 *
 * Reads come via `loadTurnState` on cold start (spec #101 Stage 6 — still in
 * `session-do-helpers.ts`). This is fire-and-forget; a SQLite hiccup must
 * not crash a turn.
 */
export function persistTurnState(ctx: SessionDOContext): void {
  try {
    ctx.sql.exec(
      `INSERT OR REPLACE INTO assistant_config (session_id, key, value) VALUES ('', 'turnCounter', ?)`,
      String(ctx.do.turnCounter),
    )
    ctx.sql.exec(
      `INSERT OR REPLACE INTO assistant_config (session_id, key, value) VALUES ('', 'currentTurnMessageId', ?)`,
      ctx.do.currentTurnMessageId ?? '',
    )
  } catch (err) {
    console.error(`[SessionDO:${ctx.ctx.id}] Failed to persist turn state:`, err)
  }
}

/**
 * Bump `turnCounter` by 1 and persist the new value. Returns the new
 * counter value so callers that mint canonical message ids
 * (`usr-${n}` / `msg-${n}` / `err-${n}`) can chain in one call.
 */
export function bumpTurnCounter(ctx: SessionDOContext): number {
  ctx.do.turnCounter += 1
  // Caller normally pairs with `persistTurnState(ctx)` after a successful
  // append; we don't persist here to preserve the existing call ordering
  // (some sites bump+append+persist; others persist later in a batch).
  return ctx.do.turnCounter
}
