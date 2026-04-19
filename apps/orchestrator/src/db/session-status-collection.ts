/**
 * Session Status LocalOnlyCollection — caches status-bar-relevant snapshots
 * in OPFS SQLite so tab switches render instantly without waiting on the
 * WS state sync, getContextUsage RPC, kata WS event, or /api/gateway/projects
 * fetch.
 *
 * - Collection id: 'session_status'
 * - Persisted to OPFS SQLite (schema version 1)
 * - One row per sessionId; shape mirrors useStatusBarStore fields
 * - Write-through: AgentDetailView upserts on every live update
 * - Read path: synchronous .get(id) for hydration before first paint
 */

import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import { createCollection, localOnlyCollectionOptions } from '@tanstack/db'
import type { KataSessionState, SessionState } from '~/lib/types'
import type { ContextUsage, WorktreeInfo } from '~/stores/status-bar'
import { dbReady } from './db-instance'

/** Cached snapshot for a single session — powers the status bar cache-first. */
export interface CachedSessionStatus {
  id: string
  state: SessionState | null
  contextUsage: ContextUsage | null
  kataState: KataSessionState | null
  worktreeInfo: WorktreeInfo | null
  sessionResult: { total_cost_usd: number; duration_ms: number } | null
  updatedAt: string
}

const persistence = await dbReady

function createSessionStatusCollection() {
  const localOpts = localOnlyCollectionOptions<CachedSessionStatus, string>({
    id: 'session_status',
    getKey: (item: CachedSessionStatus) => item.id,
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

export const sessionStatusCollection = createSessionStatusCollection()

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
 */
export function writeSessionStatusCache(
  sessionId: string,
  patch: Partial<Omit<CachedSessionStatus, 'id' | 'updatedAt'>>,
): void {
  const updatedAt = new Date().toISOString()
  const normalized: Partial<CachedSessionStatus> = { ...patch, updatedAt }
  if ('state' in normalized) {
    normalized.state = sanitizeState(normalized.state ?? null)
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionStatusCollection as any
    if (coll.has?.(sessionId)) {
      coll.update(sessionId, (draft: CachedSessionStatus) => {
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
        ...normalized,
      } as CachedSessionStatus)
    }
  } catch {
    // collection may not be ready; swallow
  }
}

/**
 * Synchronous read — safe to call in useLayoutEffect before first paint so
 * StatusBar hydrates cache-first and avoids the blank-flash on tab switch.
 * Returns null when the row doesn't exist, the collection isn't ready, or
 * OPFS is unavailable.
 */
export function readSessionStatusCache(sessionId: string): CachedSessionStatus | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coll = sessionStatusCollection as any
    const row = coll.get?.(sessionId)
    return (row as CachedSessionStatus | undefined) ?? null
  } catch {
    return null
  }
}
