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
import type { KataSessionState, SessionState, SessionStatus } from '~/lib/types'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'
import { dbReady } from './db-instance'

/** Live state snapshot for a single session — render source for status/composer. */
export interface SessionLiveState {
  id: string
  state: SessionState | null
  contextUsage: ContextUsage | null
  kataState: KataSessionState | null
  worktreeInfo: WorktreeInfo | null
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
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
      schemaVersion: 2,
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
 * Strip sensitive / non-persistable fields from SessionState before caching.
 * `active_callback_token` is a gateway-dial bearer; don't round-trip it into
 * OPFS even though the browser-facing WS state shouldn't carry it.
 */
function sanitizeState(s: SessionState | null): SessionState | null {
  if (!s) return null
  if (!('active_callback_token' in s)) return s
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { active_callback_token, ...rest } = s as SessionState & {
    active_callback_token?: string
  }
  return rest as SessionState
}

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
  if ('state' in normalized) {
    normalized.state = sanitizeState(normalized.state ?? null)
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionLiveStateCollection as any
    if (coll.has?.(sessionId)) {
      coll.update(sessionId, (draft: SessionLiveState) => {
        Object.assign(draft, normalized)
      })
    } else {
      coll.insert({
        id: sessionId,
        state: null,
        contextUsage: null,
        kataState: null,
        worktreeInfo: null,
        sessionResult: null,
        wsReadyState: 3,
        ...normalized,
      } as SessionLiveState)
    }
  } catch {
    // collection may not be ready; swallow
  }
}

/**
 * Offline-hydrate entry point: upsert a row from a `SessionSummary` with
 * `wsReadyState: 3` (closed). Used by SessionHistory / SessionListItem to
 * populate rows for sessions that were never opened in this browser
 * session, so the collection remains the single source of truth for
 * session-list readers.
 */
export function seedSessionLiveStateFromSummary(summary: SessionSummary): void {
  upsertSessionLiveState(summary.id, {
    wsReadyState: 3,
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
