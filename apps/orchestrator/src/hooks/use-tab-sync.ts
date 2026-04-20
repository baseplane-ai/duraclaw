/**
 * useTabSync — D1-backed tab list (via `userTabsCollection`), local active tab.
 *
 * Row model (user_tabs, one row per open tab):
 *   - `id`          — random row id (surrogate key for PATCH / DELETE)
 *   - `sessionId`   — external key consumed by the UI. Either a real
 *                     agent_session id, a draft id (`draft:<uuid>`), or a
 *                     chain key (`chain:<issueNumber>`).
 *   - `position`    — integer, `ORDER BY position` drives render order.
 *                     Fractional inserts and drag reorders are expressed
 *                     as contiguous rewrites — see `computeInsertOrder`.
 *   - `meta` (JSON) — stringified `TabMeta`: `{kind, project, issueNumber,
 *                     activeSessionId}`. Adding a meta field is a pure
 *                     client change — the server stores it opaquely.
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
 *
 * One-chain-per-issue: chain tabs carry `meta.kind === 'chain'` +
 * `meta.issueNumber`. A chain tab for an issue that already has one
 * simply re-focuses the existing tab instead of replacing.
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
  /** Tab kind. Absent / 'session' = regular session tab; 'chain' = chain tab. */
  kind?: 'chain' | 'session'
  /** Issue number — required when kind === 'chain' (cluster key). */
  issueNumber?: number
}

export interface TabEntry {
  project?: string
  order: number
  /** Absent → 'session' (backwards-compat with legacy entries). */
  kind?: 'chain' | 'session'
  /** Required when kind === 'chain'. */
  issueNumber?: number
  /** Which mode session inside the chain is currently live (chain tabs). */
  activeSessionId?: string
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

/** Effective tab kind — treats `undefined` as 'session' for legacy rows. */
function entryKind(e: Pick<TabEntry, 'kind'>): 'chain' | 'session' {
  return e.kind === 'chain' ? 'chain' : 'session'
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
   * Full per-tab entry map (reactive). Keyed by sessionId / chain key.
   * Prefer this over `tabProjects` for new code — it carries `kind`,
   * `issueNumber`, and `activeSessionId` in addition to `project`.
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
  replaceTab: (oldId: string, newId: string) => void
  /** Set the active session (local only). */
  setActive: (sessionId: string | null) => void
  /** Find an existing chain tab for an issue. Returns its sessionId or null. */
  findTabByIssue: (issueNumber: number) => string | null
  /** True once the collection has loaded its initial data. */
  hydrated: boolean
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
  if (m.issueNumber !== undefined) out.issueNumber = m.issueNumber
  if (m.activeSessionId !== undefined) out.activeSessionId = m.activeSessionId
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
 *   - `issue:N`   → membership test `e.kind === 'chain' && e.issueNumber === N`
 *   - `project:P` → membership test `e.kind !== 'chain' && e.project === P`
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
    kind?: 'chain' | 'session'
    issueNumber?: number
  }>,
  clusterKey: string | null,
  reusedOrder: number | null,
): number {
  if (reusedOrder !== null) return reusedOrder

  const maxOrder = entries.reduce((m, e) => (e.order > m ? e.order : m), 0)

  if (!clusterKey) return maxOrder + 1

  const matches = (e: {
    project?: string
    kind?: 'chain' | 'session'
    issueNumber?: number
  }): boolean => {
    if (clusterKey.startsWith('issue:')) {
      const n = Number(clusterKey.slice('issue:'.length))
      if (!Number.isFinite(n)) return false
      return entryKind(e) === 'chain' && e.issueNumber === n
    }
    if (clusterKey.startsWith('project:')) {
      const p = clusterKey.slice('project:'.length)
      return entryKind(e) !== 'chain' && e.project === p
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
  const { data, isLoading } = useLiveQuery(userTabsCollection as any)

  const rows = useMemo(() => projectRows((data as UserTabRow[]) ?? []), [data])

  const openTabs = useMemo(() => rows.map((r) => r.sessionId as string), [rows])

  const tabEntries = useMemo(() => {
    const out: Record<string, TabEntry> = {}
    for (const r of rows) {
      const m = r.meta
      const entry: TabEntry = { order: r.position }
      if (m.project !== undefined) entry.project = m.project
      if (m.kind === 'chain') entry.kind = 'chain'
      if (m.issueNumber !== undefined) entry.issueNumber = m.issueNumber
      if (m.activeSessionId !== undefined) entry.activeSessionId = m.activeSessionId
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

  const findTabByIssue = useCallback(
    (issueNumber: number): string | null => {
      for (const r of rows) {
        if (r.meta.kind === 'chain' && r.meta.issueNumber === issueNumber) {
          return r.sessionId as string
        }
      }
      return null
    },
    [rows],
  )

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
      const kind: 'chain' | 'session' = opts?.kind === 'chain' ? 'chain' : 'session'
      const issueNumber = opts?.issueNumber

      // Guard: chain tab requires a numeric issueNumber.
      if (kind === 'chain' && typeof issueNumber !== 'number') return

      // Read live collection state for the existence checks instead of the
      // React `rows` snapshot — `rows` is stale across the same render cycle,
      // so two synchronous `openTab(sessionId, …)` calls (e.g. a useEffect
      // re-fire racing with a click handler) would both miss the existing row
      // and both insert. `tabs.toArray` reflects the optimistic write from
      // the first call.
      const liveRows = projectRows(tabs.toArray)

      // One-chain-per-issue: if a chain tab for this issue already exists,
      // focus it instead of adding another.
      if (kind === 'chain' && typeof issueNumber === 'number') {
        const existing = liveRows.find(
          (r) => r.meta.kind === 'chain' && r.meta.issueNumber === issueNumber,
        )
        if (existing) {
          setActive(existing.sessionId as string)
          return
        }
      }

      // Already-open under this exact sessionId — update meta.project for
      // session tabs (chain tabs don't carry project), then activate.
      const same = liveRows.find((r) => r.sessionId === sessionId)
      if (same) {
        if (kind === 'session' && project && same.meta.project !== project) {
          tabs.update(same.id, (draft: UserTabRow) => {
            draft.meta = stringifyMeta({ ...same.meta, project })
          })
        }
        setActive(sessionId)
        return
      }

      const clusterKey: string | null =
        kind === 'chain' && typeof issueNumber === 'number'
          ? `issue:${issueNumber}`
          : kind === 'session' && project
            ? `project:${project}`
            : null

      // One-tab-per-project (session tabs only): find existing tab(s) for
      // the same project and delete them. Remember one of their orders so
      // the replacement slots back into the same position.
      let reusedOrder: number | null = null
      if (kind === 'session' && !forceNewTab && project) {
        for (const r of liveRows) {
          if (r.meta.kind !== 'chain' && r.meta.project === project) {
            if (reusedOrder === null) reusedOrder = r.position
            tabs.delete(r.id)
          }
        }
      }

      const remainingEntries =
        reusedOrder !== null
          ? liveRows
              .filter((r) => !(r.meta.kind !== 'chain' && r.meta.project === project))
              .map((r) => ({
                order: r.position,
                project: r.meta.project,
                kind: r.meta.kind,
                issueNumber: r.meta.issueNumber,
              }))
          : liveRows.map((r) => ({
              order: r.position,
              project: r.meta.project,
              kind: r.meta.kind,
              issueNumber: r.meta.issueNumber,
            }))

      const order = computeInsertOrder(remainingEntries, clusterKey, reusedOrder)

      const meta: TabMeta =
        kind === 'chain' ? { kind: 'chain', issueNumber } : project !== undefined ? { project } : {}

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
    (oldId: string, newId: string) => {
      if (oldId === newId) return
      const row = rows.find((r) => r.sessionId === oldId)
      if (!row) return

      // If newId is already open, drop the draft and activate the existing one.
      const dupe = rows.find((r) => r.sessionId === newId)
      if (dupe) {
        tabs.delete(row.id)
        if (activeSessionId === oldId) setActive(newId)
        return
      }

      tabs.update(row.id, (draft: UserTabRow) => {
        draft.sessionId = newId
      })
      if (activeSessionId === oldId) setActive(newId)
    },
    [rows, activeSessionId, setActive],
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
    hydrated: !isLoading,
    openTab,
    closeTab,
    replaceTab,
    setActive,
    findTabByIssue,
    reorder,
    status,
  }
}
