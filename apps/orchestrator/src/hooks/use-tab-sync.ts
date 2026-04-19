/**
 * useTabSync — Yjs-backed tab list, local active tab.
 *
 * Y.Doc schema (synced cross-device via UserSettingsDO):
 *   - Y.Map<string> "tabs" — key: sessionId, value: JSON { project, order }
 *
 * Active tab is LOCAL (useState + localStorage). Cross-device tab *list*
 * sync is the useful part; cross-device active-tab sync creates fights
 * (device A's click yanks device B's focus) and effect ping-pong loops
 * (deep-link reads URL → sets Yjs → URL-sync reads Yjs → navigates →
 * deep-link fires again).
 *
 * Why Y.Map instead of Y.Array:
 * Y.Array push() creates unique CRDT items. Push before IndexedDB
 * hydration + hydration load = two items for the same session.
 * Y.Map.set() on the same key converges to one entry. No duplicates.
 *
 * One-tab-per-project: openTab scans the map for an existing entry with
 * the same project name and removes it before inserting the new one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'

export interface OpenTabOptions {
  /** Project name for one-tab-per-project enforcement. */
  project?: string
  /** Force a new tab even if another tab for the same project exists. */
  forceNewTab?: boolean
}

interface TabEntry {
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
  /** Ordered list of open session IDs (reactive, sorted by order). */
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
   * Open or activate a tab. Idempotent — Y.Map keys can't duplicate.
   * When a project is provided, enforces one-tab-per-project (removes
   * existing tab for the same project unless forceNewTab is set).
   */
  openTab: (sessionId: string, options?: OpenTabOptions) => void
  /** Remove a session from open tabs. Returns the next active session ID. */
  closeTab: (sessionId: string) => string | null
  /**
   * Replace a tab's key (e.g. draft → real session ID) while preserving
   * order and project metadata. Activates the new id if the old id was
   * active. No-op if oldId isn't present.
   */
  replaceTab: (oldId: string, newId: string) => void
  /** Set the active session (local only). */
  setActive: (sessionId: string | null) => void
  /** True once IndexedDB has loaded local Y.Doc state. */
  hydrated: boolean
  /** Reorder: move the tab at fromIndex to toIndex. */
  reorder: (fromIndex: number, toIndex: number) => void
  /** Yjs provider connection status. */
  status: 'connecting' | 'connected' | 'disconnected'
}

/**
 * Imperative read for keyboard handlers and other non-React callers.
 */
export function getTabSyncSnapshot(): {
  openTabs: string[]
  activeSessionId: string | null
} {
  if (!sharedDoc) return { openTabs: [], activeSessionId: null }
  return {
    openTabs: sortedTabIds(sharedDoc.getMap<string>('tabs')),
    activeSessionId: localStorage.getItem(ACTIVE_TAB_KEY),
  }
}

/** Parse a tab entry value (JSON string → TabEntry). */
function parseEntry(val: unknown): TabEntry {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as TabEntry
    } catch {
      return { order: 0 }
    }
  }
  return { order: 0 }
}

/** Return session IDs sorted by their order field. */
function sortedTabIds(tabsMap: Y.Map<string>): string[] {
  const entries: Array<{ id: string; order: number }> = []
  tabsMap.forEach((val, key) => {
    entries.push({ id: key, order: parseEntry(val).order })
  })
  entries.sort((a, b) => a.order - b.order)
  return entries.map((e) => e.id)
}

/**
 * Decide where to slot a newly opened tab so it "stays put" inside its
 * project cluster instead of always jumping to the far right.
 *
 * Rules (exported for unit testing):
 *  - `reusedOrder` is set only on the replace path (one-tab-per-project).
 *    The new tab takes the exact slot of the tab it replaced.
 *  - Otherwise, if the project already has tabs (force-new-tab alongside
 *    path), insert immediately after the last same-project tab using a
 *    fractional order between that tab and the next non-project tab.
 *  - If no existing project tabs (truly new project), append at end.
 *  - If `project` is undefined, append at end.
 *
 * `entries` must be the tabs snapshot taken BEFORE any replace-delete,
 * so `reusedOrder` (captured from the deleted tab) is not present in the
 * list passed here (the caller deletes first and drops them from the
 * entries list, OR — simpler — the caller passes the vacated order via
 * `reusedOrder` directly).
 */
export function computeInsertOrder(
  entries: ReadonlyArray<{ order: number; project?: string }>,
  project: string | undefined,
  reusedOrder: number | null,
): number {
  if (reusedOrder !== null) return reusedOrder

  const maxOrder = entries.reduce((m, e) => (e.order > m ? e.order : m), 0)

  if (!project) return maxOrder + 1

  const sameProject = entries.filter((e) => e.project === project)
  if (sameProject.length === 0) return maxOrder + 1

  const lastProjectOrder = sameProject.reduce((m, e) => (e.order > m ? e.order : m), -Infinity)
  const nextOrders = entries.filter((e) => e.order > lastProjectOrder).map((e) => e.order)
  if (nextOrders.length === 0) return lastProjectOrder + 1
  const nextOrder = nextOrders.reduce((m, o) => (o < m ? o : m), Infinity)
  return (lastProjectOrder + nextOrder) / 2
}

/** Build a {sessionId → project} map from the Yjs tabs map. */
function buildProjectMap(tabsMap: Y.Map<string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  tabsMap.forEach((val, key) => {
    out[key] = parseEntry(val).project
  })
  return out
}

// Module-level Y.Doc reference for imperative reads (getTabSyncSnapshot).
let sharedDoc: Y.Doc | null = null
let sharedDocMountCount = 0

export function useTabSync(): UseTabSyncResult {
  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const userId = session?.user?.id ?? null

  const doc = useMemo(() => {
    if (!userId) return null
    const d = new Y.Doc()
    d.guid = `user-settings:${userId}`
    return d
  }, [userId])

  useEffect(() => {
    if (!doc) return
    sharedDoc = doc
    sharedDocMountCount++
    return () => {
      sharedDocMountCount--
      if (sharedDocMountCount === 0) sharedDoc = null
    }
  }, [doc])

  // "tabs" Y.Map — synced cross-device.
  const tabsY = useMemo(() => doc?.getMap<string>('tabs') ?? null, [doc])

  const host = typeof window !== 'undefined' && window.location ? window.location.host : ''

  const provider = useYProvider({
    host,
    room: userId ?? '',
    party: 'user-settings',
    doc: doc ?? undefined,
    options: { connect: Boolean(userId) },
  })

  // IndexedDB persistence for offline cold-start.
  // `hydrated` signals when local state has been loaded so the UI can
  // avoid rendering an empty tab bar that flashes before data arrives.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (!userId || !doc) return
    setHydrated(false)
    let destroyed = false
    let idb: { destroy: () => void } | null = null
    import('y-indexeddb').then(({ IndexeddbPersistence }) => {
      if (destroyed) return
      const persistence = new IndexeddbPersistence(`user-settings:${userId}`, doc)
      idb = persistence
      persistence.once('synced', () => {
        if (!destroyed) setHydrated(true)
      })
    })
    return () => {
      destroyed = true
      idb?.destroy()
    }
  }, [userId, doc])

  // Connection status tracking.
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  useEffect(() => {
    if (!provider) return
    const onStatus = (payload: { status?: string } | undefined) => {
      const next = payload?.status
      if (next === 'connected' || next === 'connecting' || next === 'disconnected') {
        setStatus(next)
      }
    }
    provider.on('status', onStatus as never)
    return () => {
      provider.off('status', onStatus as never)
    }
  }, [provider])

  // ── Tab list (Yjs-synced, reactive) ─────────────────────────────────

  const [openTabs, setOpenTabs] = useState<string[]>(() => (tabsY ? sortedTabIds(tabsY) : []))
  const [tabProjects, setTabProjects] = useState<Record<string, string | undefined>>(() =>
    tabsY ? buildProjectMap(tabsY) : {},
  )

  useEffect(() => {
    if (!tabsY) return
    const handler = () => {
      setOpenTabs(sortedTabIds(tabsY))
      setTabProjects(buildProjectMap(tabsY))
    }
    tabsY.observe(handler)
    setOpenTabs(sortedTabIds(tabsY))
    setTabProjects(buildProjectMap(tabsY))
    return () => tabsY.unobserve(handler)
  }, [tabsY])

  // ── Active tab (local, persisted to localStorage) ───────────────────

  const [activeSessionId, setActiveState] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_TAB_KEY),
  )

  const setActive = useCallback((sessionId: string | null) => {
    setActiveState(sessionId)
    if (sessionId) {
      localStorage.setItem(ACTIVE_TAB_KEY, sessionId)
    } else {
      localStorage.removeItem(ACTIVE_TAB_KEY)
    }
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────

  const openTab = useCallback(
    (sessionId: string, opts?: OpenTabOptions) => {
      const project = opts?.project
      const forceNewTab = opts?.forceNewTab ?? false
      if (!doc || !tabsY) return

      doc.transact(() => {
        const existing = tabsY.get(sessionId)

        if (existing) {
          // Already open — update project if newly known.
          if (project) {
            const entry = parseEntry(existing)
            if (entry.project !== project) {
              tabsY.set(sessionId, JSON.stringify({ ...entry, project }))
            }
          }
          // Activate (local).
          setActive(sessionId)
          return
        }

        // Snapshot the current tab entries up front so we can reason about
        // ordering without re-reading the map after mutation.
        const entries: Array<{ id: string; order: number; project?: string }> = []
        tabsY.forEach((val, key) => {
          const entry = parseEntry(val)
          entries.push({ id: key, order: entry.order, project: entry.project })
        })

        // One-tab-per-project: remove existing tab(s) for the same
        // project. Remember one of their orders so the replacement slots
        // back into the same position instead of jumping to the end.
        let reusedOrder: number | null = null
        if (!forceNewTab && project) {
          for (const e of entries) {
            if (e.project === project) {
              if (reusedOrder === null) reusedOrder = e.order
              tabsY.delete(e.id)
            }
          }
        }

        // Exclude any entries we just deleted from the insertion math so
        // the "next tab after the project cluster" lookup is accurate.
        const remaining =
          reusedOrder !== null ? entries.filter((e) => e.project !== project) : entries

        const order = computeInsertOrder(remaining, project, reusedOrder)

        tabsY.set(sessionId, JSON.stringify({ project, order }))
      })

      // Activate (local, outside transaction).
      setActive(sessionId)
    },
    [doc, tabsY, setActive],
  )

  const closeTab = useCallback(
    (sessionId: string): string | null => {
      if (!doc || !tabsY) return null
      let nextActive: string | null = null
      doc.transact(() => {
        if (!tabsY.has(sessionId)) return
        const sorted = sortedTabIds(tabsY)
        const idx = sorted.indexOf(sessionId)
        tabsY.delete(sessionId)

        if (activeSessionId === sessionId) {
          const remaining = sorted.filter((id) => id !== sessionId)
          nextActive = remaining[Math.min(idx, remaining.length - 1)] ?? null
        }
      })

      if (activeSessionId === sessionId) {
        setActive(nextActive)
      }
      return nextActive
    },
    [doc, tabsY, activeSessionId, setActive],
  )

  const replaceTab = useCallback(
    (oldId: string, newId: string) => {
      if (!doc || !tabsY) return
      if (oldId === newId) return
      doc.transact(() => {
        const val = tabsY.get(oldId)
        if (!val) return
        // If newId is already open, drop the draft and activate the existing one.
        if (tabsY.has(newId)) {
          tabsY.delete(oldId)
          return
        }
        tabsY.delete(oldId)
        tabsY.set(newId, val)
      })
      if (activeSessionId === oldId) {
        setActive(newId)
      }
    },
    [doc, tabsY, activeSessionId, setActive],
  )

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!doc || !tabsY) return
      doc.transact(() => {
        const sorted = sortedTabIds(tabsY)
        if (fromIndex < 0 || fromIndex >= sorted.length) return
        if (toIndex < 0 || toIndex >= sorted.length) return

        const moved = sorted.splice(fromIndex, 1)[0]
        sorted.splice(toIndex, 0, moved)

        for (let i = 0; i < sorted.length; i++) {
          const id = sorted[i]
          const entry = parseEntry(tabsY.get(id))
          tabsY.set(id, JSON.stringify({ ...entry, order: i + 1 }))
        }
      })
    },
    [doc, tabsY],
  )

  return {
    openTabs,
    activeSessionId,
    tabProjects,
    hydrated,
    openTab,
    closeTab,
    replaceTab,
    setActive,
    reorder,
    status,
  }
}
