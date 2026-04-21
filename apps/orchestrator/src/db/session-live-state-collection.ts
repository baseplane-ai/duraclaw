/**
 * Session Live State LocalOnlyCollection — the single render source for
 * per-session live state (connection, context usage, kata, worktree, result).
 *
 * This collection replaces the old `session_status` OPFS cache. Instead of
 * threading transient WS/context/kata data through React context + stores
 * + a cache-behind mirror, components read directly from this collection
 * and AgentDetailView / the WS layer write through it on every update.
 *
 * - Collection id: 'session_live_state'
 * - Persisted to OPFS SQLite (schema version 1)
 * - One row per sessionId; mirrors the fields the status bar + composer need
 * - Synchronous read via TanStackDB live queries (no loading flash on tab switch)
 */

import type { SessionSummary } from '@duraclaw/shared-types'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import type { KataSessionState, SessionStatus } from '~/lib/types'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'
import { dbReady } from './db-instance'

/**
 * Live state snapshot for a single session.
 *
 * Spec #31 P5 B10 narrowing: `state` (full SessionState), `sessionResult`,
 * and any non-D1-mirrored live fields are removed. Status / gate / result
 * are derived client-side from `messagesCollection` via `useDerivedStatus`
 * / `useDerivedGate`. `contextUsage` / `kataState` remain on the collection
 * pending the deferred consumer-migration issue. The `status` (top-level)
 * and other summary fields are kept as the D1-mirrored source for non-
 * active callers (SessionListItem, SessionCardList, SessionHistory,
 * ChainPage) that don't mount `useCodingAgent`.
 */
export interface SessionLiveState {
  id: string
  contextUsage: ContextUsage | null
  kataState: KataSessionState | null
  worktreeInfo: WorktreeInfo | null
  wsReadyState: number
  updatedAt: string
  // GH#14 B8 — schema v2: expanded to subsume SessionSummary fields so
  // sessionLiveStateCollection is the single source of truth for session
  // list readers (tab-bar, SessionListItem, SessionHistory). Only
  // project/model/prompt/archived/createdAt are spec-listed; the rest are
  // reader dependencies.
  project?: string
  model?: string | null
  prompt?: string
  archived?: boolean
  createdAt?: string
  userId?: string | null
  lastActivity?: string | null
  numTurns?: number | null
  totalCostUsd?: number | null
  durationMs?: number | null
  messageCount?: number | null
  summary?: string
  title?: string | null
  tag?: string | null
  origin?: string | null
  agent?: string | null
  sdkSessionId?: string | null
  kataMode?: string | null
  kataIssue?: number | null
  kataPhase?: string | null
  /** D1-mirrored session status for non-active sidebar readers. Live
   *  (active-session) callers derive status from `useDerivedStatus` over
   *  `messagesCollection` instead. */
  status?: SessionStatus
}

const persistence = await dbReady

function createSessionLiveStateCollection() {
  const localOpts = localOnlyCollectionOptions<SessionLiveState, string>({
    id: 'session_live_state',
    getKey: (item: SessionLiveState) => item.id,
  })

  if (persistence) {
    const opts = persistedCollectionOptions({
      ...localOpts,
      persistence,
      // Schema bump (#31 P5 B10): SessionLiveState narrowed — old rows with
      // `state` / `sessionResult` columns are dropped on upgrade per
      // persistedCollectionOptions semantics.
      schemaVersion: 3,
    })
    // TanStackDB beta: persistedCollectionOptions adds a schema type that
    // conflicts with createCollection overloads. Runtime behavior is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCollection(opts as any)
  }

  return createCollection(localOpts)
}

export const sessionLiveStateCollection = createSessionLiveStateCollection()

/**
 * Upsert a partial snapshot for a session. Fields omitted from `patch`
 * preserve their prior cached values (patch-style merge, not replace).
 * Insert path fills nulls for omitted fields; `wsReadyState` defaults to
 * 3 (closed) when not in patch.
 */
export function upsertSessionLiveState(
  sessionId: string,
  patch: Partial<Omit<SessionLiveState, 'id' | 'updatedAt'>>,
): void {
  const updatedAt = new Date().toISOString()
  const normalized: Partial<SessionLiveState> = { ...patch, updatedAt }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionLiveStateCollection as any
    // DB-cbb1-0420: use update-first-insert-fallback to avoid the
    // `coll.has?.()` undefined-optional-chain bug. On persisted
    // collections `.has` may not be wired through the persistence
    // adapter, returning undefined and always falling through to
    // `.insert()` — which throws duplicate-key on the second call for
    // the same sessionId. The outer catch swallowed the throw, meaning
    // every upsert after the first insert was silently dropped: no
    // worktreeInfo, no wsReadyState updates, no contextUsage updates.
    try {
      coll.update(sessionId, (draft: SessionLiveState) => {
        Object.assign(draft, normalized)
      })
    } catch {
      // Update threw (row doesn't exist yet) — insert fresh.
      try {
        coll.insert({
          id: sessionId,
          contextUsage: null,
          kataState: null,
          worktreeInfo: null,
          wsReadyState: 3,
          ...normalized,
        } as SessionLiveState)
      } catch {
        // Both failed — collection may not be ready; swallow.
      }
    }
  } catch {
    // collection may not be ready; swallow
  }
}

/**
 * Offline-hydrate entry point: upsert a row from a `SessionSummary`. Used
 * by SessionHistory / SessionListItem / `backfillFromRest` to populate
 * rows for sessions that were never opened in this browser session, so
 * the collection remains the single source of truth for session-list
 * readers.
 *
 * Does NOT include `wsReadyState` in the patch: on insert, the upsert
 * defaults it to `3` (closed); on update, omitting it preserves the live
 * value written by `useCodingAgent`'s readyState mirror. Including it
 * previously clobbered the active session's OPEN state back to CLOSED on
 * every `backfillFromRest` call (triggered on mount + window focus +
 * reconnect), leaving the StatusBar's WS dot stuck red even while the
 * socket was fine.
 */
export function seedSessionLiveStateFromSummary(summary: SessionSummary): void {
  upsertSessionLiveState(summary.id, {
    project: summary.project,
    model: summary.model,
    prompt: summary.prompt,
    archived: !!summary.archived,
    createdAt: summary.createdAt,
    userId: summary.userId,
    lastActivity: summary.lastActivity ?? null,
    numTurns: summary.numTurns ?? null,
    totalCostUsd: summary.totalCostUsd ?? null,
    durationMs: summary.durationMs ?? null,
    messageCount: summary.messageCount ?? null,
    summary: summary.summary,
    title: summary.title ?? null,
    tag: summary.tag ?? null,
    origin: summary.origin ?? null,
    agent: summary.agent ?? null,
    sdkSessionId: summary.sdkSessionId ?? null,
    kataMode: summary.kataMode ?? null,
    kataIssue: summary.kataIssue ?? null,
    kataPhase: summary.kataPhase ?? null,
    status: summary.status,
  })
}
