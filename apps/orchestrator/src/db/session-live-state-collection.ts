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

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import type { KataSessionState, SessionState } from '~/lib/types'
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
      schemaVersion: 1,
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
