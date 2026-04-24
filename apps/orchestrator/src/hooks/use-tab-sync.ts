/**
 * useTabSync — D1-backed tab list (via `userTabsCollection`), local active tab.
 *
 * Row model (user_tabs, one row per open tab):
 *   - `id`          — random row id (surrogate key for PATCH / DELETE)
 *   - `sessionId`   — external key consumed by the UI. Either a real
 *                     agent_session id or a draft id (`draft:<uuid>`).
 *   - `position`    — integer, `ORDER BY position` drives render order.
 *                     Fractional inserts and drag reorders are expressed
 *                     as contiguous rewrites — see `computeInsertOrder`.
 *   - `meta` (JSON) — stringified `TabMeta`: `{kind, project}`. Adding a
 *                     meta field is a pure client change — the server
 *                     stores it opaquely.
 *
 * Active tab is LOCAL (useState + localStorage under
 * `duraclaw-active-session`). Cross-device tab *list* sync is the useful
 * part; cross-device active-tab sync creates fights (device A's click
 * yanks device B's focus) and effect ping-pong (deep-link reads URL →
 * mutates synced state → URL-sync reads it back → navigates → deep-link
 * fires again).
 *
 * Why surrogate `id` instead of keying by `sessionId`:
 * The D1 server-echo reconciliation on `userTabsCollection` requires a
 * stable primary key that survives rename (draft → real session id). A
 * separate `id` lets `replaceTab(oldSessionId, newSessionId)` be a
 * PATCH on the existing row rather than a delete+insert (which would
 * drop the row's `position` and any pending drafts).
 *
 * One-tab-per-project: `openTab` scans the local collection for an
 * existing row with matching `meta.project` and removes it before
 * inserting the new one — the new row inherits the deleted tab's
 * position via `reusedOrder` so it doesn't jump to the end.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { userTabsCollection } from '~/db/user-tabs-collection'
import { apiUrl } from '~/lib/platform'
import type { TabMeta, UserTabRow } from '~/lib/types'
import { useUserStream } from './use-user-stream'

// Collection types come through from TanStack DB as `Record<string, unknown>`
// due to the `as any` erasure inside `createSyncedCollection`. Cast once at
// module scope so call sites stay readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tabs = userTabsCollection as unknown as {
  insert: (row: UserTabRow) => void
  update: (id: string, fn: (draft: UserTabRow) => void) => void
  delete: (id: string) => void
  toArray: UserTabRow[]
}

export interface OpenTabOptions {
  /** Project name for one-tab-per-project enforcement. */
  project?: string
  /** Force a new tab even if another tab for the same project exists. */
  forceNewTab?: boolean
}

export interface TabEntry {
  project?: string
  order: number
}

const ACTIVE_TAB_KEY = 'duraclaw-active-session'

/** Draft tab IDs have this prefix; the rest is a fresh UUID. */
export const DRAFT_TAB_PREFIX = 'draft:'

/** True if a tab/session id refers to a not-yet-spawned draft session. */
export function isDraftTabId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DRAFT_TAB_PREFIX)
}

/** Generate a fresh draft tab id. Uses crypto.randomUUID when available. */
export function newDraftTabId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `${DRAFT_TAB_PREFIX}${rand}`
}

export interface UseTabSyncResult {
  /** Ordered list of open session IDs (reactive, sorted by position). */
  openTabs: string[]
  /** Currently focused session ID (local, not synced cross-device). */
  activeSessionId: string | null
  /**
   * Per-tab project map. Keyed by sessionId — includes draft tabs that
   * don't yet have a row in the sessions collection. Useful for rendering
   * a sane label before the session record exists.
   */
  tabProjects: Record<string, string | undefined>
  /**
   * Full per-tab entry map (reactive). Keyed by sessionId. Prefer this
   * over `tabProjects` for new code — it carries the full entry shape.
   */
  tabEntries: Record<string, TabEntry>
  /**
   * Open or activate a tab. Idempotent — a tab for an existing sessionId
   * is activated rather than re-created. When a project is provided,
   * enforces one-tab-per-project (removes existing tab for the same
   * project unless forceNewTab is set).
   */
  openTab: (sessionId: string, options?: OpenTabOptions) => void
  /** Remove a session from open tabs. Returns the next active session ID. */
  closeTab: (sessionId: string) => string | null
  /**
   * Replace a tab's sessionId (e.g. draft → real session ID) while
   * preserving order and project metadata. Activates the new id if the
   * old id was active. No-op if oldId isn't present.
   */
  replaceTab: (oldId: string, newId: string, opts?: { dedupProject?: string }) => void
  /** Set the active session (local only). */
  setActive: (sessionId: string | null) => void
  /** Reorder: move the tab at fromIndex to toIndex. */
  reorder: (fromIndex: number, toIndex: number) => void
  /** User-stream WS status, mapped to the legacy shape for existing callers. */
  status: 'connecting' | 'connected' | 'disconnected'
}

/** Snapshot shape used by `getTabSyncSnapshot`. */
interface TabRowLite {
  id: string
  sessionId: string | null
  position: number
  meta: TabMeta
}

/** Parse the stringified `meta` JSON with a forgiving fallback. */
function parseMeta(raw: string | null | undefined): TabMeta {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as TabMeta) : {}
  } catch {
    return {}
  }
}

/** Stringify `TabMeta` dropping undefined fields to keep payloads small. */
function stringifyMeta(m: TabMeta): string {
  const out: TabMeta = {}
  if (m.kind) out.kind = m.kind
  if (m.project !== undefined) out.project = m.project
  if (typeof m.lastSeenSeq === 'number') out.lastSeenSeq = m.lastSeenSeq
  return JSON.stringify(out)
}

/**
 * Project the collection's rows into ordered TabRowLite. Soft-deleted rows
 * are already filtered by the REST GET handler; this is a defensive filter
 * for any that arrive via delta frames before the server's soft-delete
 * semantics are honoured by all writers.
 */
function projectRows(rows: readonly UserTabRow[]): TabRowLite[] {
  const out: TabRowLite[] = []
  for (const r of rows) {
    if ((r as { deletedAt?: string | null }).deletedAt) continue
    if (!r.sessionId) continue
    out.push({
      id: r.id,
      sessionId: r.sessionId,
      position: r.position,
      meta: parseMeta(r.meta),
    })
  }
  // Defensive sessionId dedup — keep the row with the lexicographically
  // smallest id so render order is stable. The server-side partial unique
  // index (`idx_user_tabs_live_session_uq`) prevents this from happening in
  // steady state, but a same-render double-call to `openTab` can still
  // create a transient duplicate optimistic row before the server's reject
  // arrives, and a cross-device race may briefly surface two rows on the
  // optimistic side.
  out.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const seen = new Set<string>()
  const deduped: TabRowLite[] = []
  for (const r of out) {
    if (seen.has(r.sessionId as string)) continue
    seen.add(r.sessionId as string)
    deduped.push(r)
  }
  return deduped
}

/**
 * Decide where to slot a newly opened tab so it "stays put" inside its
 * cluster instead of always jumping to the far right.
 *
 * A cluster is identified by `clusterKey`:
 *   - `project:P` → membership test `e.project === P`
 *   - null        → no cluster; append at max+1
 *
 * Rules (exported for unit testing):
 *  - `reusedOrder` is set only on the replace path (one-tab-per-project).
 *    The new tab takes the exact slot of the tab it replaced.
 *  - Otherwise, if the cluster already has tabs (force-new-tab alongside
 *    path), insert immediately after the last same-cluster tab using a
 *    fractional order between that tab and the next non-cluster tab.
 *  - If no existing cluster tabs, append at end.
 *  - If `clusterKey` is null, append at end.
 *
 * `entries` must be the tabs snapshot taken BEFORE any replace-delete,
 * so `reusedOrder` (captured from the deleted tab) is not present in the
 * list passed here (the caller deletes first and drops them from the
 * entries list, OR — simpler — the caller passes the vacated order via
 * `reusedOrder` directly).
 */
export function computeInsertOrder(
  entries: ReadonlyArray<{
    order: number
    project?: string
  }>,
  clusterKey: string | null,
  reusedOrder: number | null,
): number {
  if (reusedOrder !== null) return reusedOrder

  const maxOrder = entries.reduce((m, e) => (e.order > m ? e.order : m), 0)

  if (!clusterKey) return maxOrder + 1

  const matches = (e: { project?: string }): boolean => {
    if (clusterKey.startsWith('project:')) {
      const p = clusterKey.slice('project:'.length)
      return e.project === p
    }
    return false
  }

  const sameCluster = entries.filter(matches)
  if (sameCluster.length === 0) return maxOrder + 1

  const lastClusterOrder = sameCluster.reduce((m, e) => (e.order > m ? e.order : m), -Infinity)
  const nextOrders = entries.filter((e) => e.order > lastClusterOrder).map((e) => e.order)
  if (nextOrders.length === 0) return lastClusterOrder + 1
  const nextOrder = nextOrders.reduce((m, o) => (o < m ? o : m), Infinity)
  return (lastClusterOrder + nextOrder) / 2
}

/**
 * Identify dedup-candidate row ids for `replaceTab` when called with
 * `opts.dedupProject`. Returns every row that belongs to the same
 * project cluster and is NOT the old draft row or a row already on the
 * new (target) sessionId — those are handled by the swap/dupe paths.
 *
 * Exported for unit testing; callers inside `useTabSync` iterate the
 * result and `tabs.delete(id)` each.
 */
export function collectReplaceTabDedupIds(
  rows: ReadonlyArray<{
    id: string
    sessionId: string | null
    meta: TabMeta
  }>,
  oldId: string,
  newId: string,
  dedupProject: string,
): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r.sessionId === oldId) continue
    if (r.sessionId === newId) continue
    if (r.meta.project !== dedupProject) continue
    out.push(r.id)
  }
  return out
}

/**
 * Imperative read for keyboard handlers and other non-React callers.
 * Reads from the collection's in-memory array — no React subscription.
 */
export function getTabSyncSnapshot(): {
  openTabs: string[]
  activeSessionId: string | null
} {
  const rows = (tabs.toArray as UserTabRow[]) ?? []
  const projected = projectRows(rows)
  return {
    openTabs: projected.map((r) => r.sessionId as string),
    activeSessionId:
      typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_TAB_KEY) : null,
  }
}

/** Short random id for new `user_tabs` rows. */
function newRowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

export function useTabSync(): UseTabSyncResult {
  // Reactive subscription to the collection. Cast because TanStack DB's beta
  // generics don't perfectly match the NonSingleResult overload; see
  // use-sessions-collection.ts for the same pattern.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = useLiveQuery(userTabsCollection as any)

  const rows = useMemo(() => projectRows((data as UserTabRow[]) ?? []), [data])

  const openTabs = useMemo(() => rows.map((r) => r.sessionId as string), [rows])

  const tabEntries = useMemo(() => {
    const out: Record<string, TabEntry> = {}
    for (const r of rows) {
      const m = r.meta
      const entry: TabEntry = { order: r.position }
      if (m.project !== undefined) entry.project = m.project
      out[r.sessionId as string] = entry
    }
    return out
  }, [rows])

  const tabProjects = useMemo(() => {
    const out: Record<string, string | undefined> = {}
    for (const r of rows) out[r.sessionId as string] = r.meta.project
    return out
  }, [rows])

  // ── Active tab (local, persisted to localStorage) ───────────────────

  const [activeSessionId, setActiveState] = useState<string | null>(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_TAB_KEY) : null,
  )

  const setActive = useCallback((sessionId: string | null) => {
    setActiveState(sessionId)
    if (typeof localStorage === 'undefined') return
    if (sessionId) {
      localStorage.setItem(ACTIVE_TAB_KEY, sessionId)
    } else {
      localStorage.removeItem(ACTIVE_TAB_KEY)
    }
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────
  //
  // Writes go through `userTabsCollection` — its `onInsert` / `onUpdate` /
  // `onDelete` handlers POST / PATCH / DELETE against
  // `/api/user-settings/tabs`, and the server rebroadcasts as a delta via
  // `broadcastSyncedDelta`. Local optimistic state reconciles with the
  // server echo through TanStack DB's deep-equality loopback.

  const openTab = useCallback(
    (sessionId: string, opts?: OpenTabOptions) => {
      const project = opts?.project
      const forceNewTab = opts?.forceNewTab ?? false

      // Read live collection state for the existence checks instead of the
      // React `rows` snapshot — `rows` is stale across the same render cycle,
      // so two synchronous `openTab(sessionId, …)` calls (e.g. a useEffect
      // re-fire racing with a click handler) would both miss the existing row
      // and both insert. `tabs.toArray` reflects the optimistic write from
      // the first call.
      const liveRows = projectRows(tabs.toArray)

      // Already-open under this exact sessionId — update meta.project, then
      // activate.
      const same = liveRows.find((r) => r.sessionId === sessionId)
      if (same) {
        if (project && same.meta.project !== project) {
          tabs.update(same.id, (draft: UserTabRow) => {
            draft.meta = stringifyMeta({ ...same.meta, project })
          })
        }
        setActive(sessionId)
        return
      }

      const clusterKey: string | null = project ? `project:${project}` : null

      // One-tab-per-project: find existing tab(s) for the same project and
      // delete them. Remember one of their orders so the replacement slots
      // back into the same position.
      let reusedOrder: number | null = null
      if (!forceNewTab && project) {
        for (const r of liveRows) {
          if (r.meta.project === project) {
            if (reusedOrder === null) reusedOrder = r.position
            tabs.delete(r.id)
          }
        }
      }

      const remainingEntries =
        reusedOrder !== null
          ? liveRows
              .filter((r) => r.meta.project !== project)
              .map((r) => ({
                order: r.position,
                project: r.meta.project,
              }))
          : liveRows.map((r) => ({
              order: r.position,
              project: r.meta.project,
            }))

      const order = computeInsertOrder(remainingEntries, clusterKey, reusedOrder)

      const meta: TabMeta = project !== undefined ? { project } : {}

      // Optimistic insert. `userId` is server-populated.
      tabs.insert({
        id: newRowId(),
        userId: '',
        sessionId,
        position: order,
        createdAt: new Date().toISOString(),
        meta: stringifyMeta(meta),
        // deletedAt intentionally omitted — NULL on insert.
      })

      setActive(sessionId)
    },
    [setActive],
  )

  const closeTab = useCallback(
    (sessionId: string): string | null => {
      const row = rows.find((r) => r.sessionId === sessionId)
      if (!row) return null

      const sorted = rows.map((r) => r.sessionId as string)
      const idx = sorted.indexOf(sessionId)

      tabs.delete(row.id)

      let nextActive: string | null = null
      if (activeSessionId === sessionId) {
        const remaining = sorted.filter((id) => id !== sessionId)
        nextActive = remaining[Math.min(idx, remaining.length - 1)] ?? null
        setActive(nextActive)
      }
      return nextActive
    },
    [rows, activeSessionId, setActive],
  )

  const replaceTab = useCallback(
    (oldId: string, newId: string, opts?: { dedupProject?: string }) => {
      if (oldId === newId) return
      // Read live collection state for the existence checks — see comment on
      // `openTab` for why `rows` (React snapshot) is stale across sync calls.
      const liveRows = projectRows(tabs.toArray)
      const row = liveRows.find((r) => r.sessionId === oldId)
      if (!row) {
        // Stuck-tab debug (2026-04-22): if the draft row the caller saw has
        // already been dropped from the React snapshot — e.g. the user_tabs
        // delta for a peer-device close landed between send-click and here —
        // the swap silently no-ops and the URL ends up pointing at an id
        // with no tab. Surface it.
        console.warn(
          '[replaceTab] old row not found',
          JSON.stringify({ oldId, newId, openRows: liveRows.map((r) => r.sessionId) }),
        )
        return
      }

      // One-tab-per-project dedup: caller opted in by passing `dedupProject`.
      // Happens BEFORE the swap/dupe paths so peer project tabs are collapsed
      // regardless of whether the target sessionId already has a row.
      if (opts?.dedupProject) {
        const dedupIds = collectReplaceTabDedupIds(liveRows, oldId, newId, opts.dedupProject)
        if (dedupIds.length > 0) {
          console.info(
            '[replaceTab] dedup',
            JSON.stringify({
              oldId,
              newId,
              project: opts.dedupProject,
              deletedRowIds: dedupIds,
            }),
          )
          for (const id of dedupIds) tabs.delete(id)
        }
      }

      // If newId is already open, drop the draft and activate the existing one.
      const dupe = liveRows.find((r) => r.sessionId === newId)
      if (dupe) {
        console.info(
          '[replaceTab] dupe path (delete draft, activate existing)',
          JSON.stringify({ oldId, newId, draftRowId: row.id, dupeRowId: dupe.id }),
        )
        tabs.delete(row.id)
        if (activeSessionId === oldId) setActive(newId)
        return
      }

      console.info(
        '[replaceTab] swap path (PATCH sessionId)',
        JSON.stringify({ oldId, newId, rowId: row.id }),
      )
      tabs.update(row.id, (draft: UserTabRow) => {
        draft.sessionId = newId
        if (opts?.dedupProject) {
          const currentMeta = parseMeta(draft.meta)
          if (currentMeta.project !== opts.dedupProject) {
            draft.meta = stringifyMeta({ ...currentMeta, project: opts.dedupProject })
          }
        }
      })
      if (activeSessionId === oldId) setActive(newId)
    },
    [activeSessionId, setActive],
  )

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (rows.length === 0) return
      if (fromIndex < 0 || fromIndex >= rows.length) return
      if (toIndex < 0 || toIndex >= rows.length) return

      const ids = rows.map((r) => r.id)
      const moved = ids.splice(fromIndex, 1)[0]
      ids.splice(toIndex, 0, moved)

      // Optimistically rewrite local positions so the reactive UI updates
      // before the server confirms. The bulk `/reorder` endpoint will
      // broadcast back the canonical positions.
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        tabs.update(id, (draft: UserTabRow) => {
          draft.position = i
        })
      }

      // Bulk reorder via the purpose-built endpoint — one transactional
      // write + one delta frame, rather than N PATCHes.
      void fetch(apiUrl('/api/user-settings/tabs/reorder'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: ids }),
      })
    },
    [rows],
  )

  // ── Cross-tab localStorage sync ─────────────────────────────────────
  // The Yjs implementation had an implicit cross-tab active-tab sync via
  // the shared Y.Doc. The D1 model keeps activeSessionId purely local, so
  // mirror the `storage` event explicitly to avoid divergence when the
  // user interacts with multiple browser tabs on the same device.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e: StorageEvent) => {
      if (e.key !== ACTIVE_TAB_KEY) return
      setActiveState(e.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Map the user-stream status to the legacy shape the UI expects.
  const { status: streamStatus } = useUserStream()
  const status: 'connecting' | 'connected' | 'disconnected' =
    streamStatus === 'open'
      ? 'connected'
      : streamStatus === 'connecting'
        ? 'connecting'
        : 'disconnected'

  return {
    openTabs,
    activeSessionId,
    tabProjects,
    tabEntries,
    openTab,
    closeTab,
    replaceTab,
    setActive,
    reorder,
    status,
  }
}
