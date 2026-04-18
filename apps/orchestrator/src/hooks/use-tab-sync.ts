/**
 * useTabSync — Yjs-backed tab state, synced cross-device via UserSettingsDO.
 *
 * The Y.Doc holds:
 *   - Y.Array<string> "openTabs"    — ordered session IDs
 *   - Y.Map<string>   "tabProjects" — sessionId → project name
 *   - Y.Map           "workspace"   — { activeSessionId: string | null }
 *
 * One-tab-per-project: openTab stores the project in the Y.Doc and
 * automatically replaces an existing tab for the same project. The
 * invariant is self-contained — no external resolver or session lookup.
 *
 * Client-side persistence: y-indexeddb gives offline cold-start so the
 * tab bar renders immediately before the WS connects. CRDT merge handles
 * any drift between IndexedDB cache and server state. A reactive dedup
 * effect cleans up legacy duplicates from both sources.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'

export interface OpenTabOptions {
  /** Project name for one-tab-per-project enforcement. */
  project?: string
  /** Force a new tab even if another tab for the same project exists. */
  forceNewTab?: boolean
}

export interface UseTabSyncResult {
  /** Ordered list of open session IDs (reactive). */
  openTabs: string[]
  /** Currently focused session ID (reactive). */
  activeSessionId: string | null
  /**
   * Open or activate a tab. Idempotent by session ID. When a project is
   * provided, enforces one-tab-per-project (replaces existing tab for the
   * same project unless forceNewTab is set). Always activates the tab.
   */
  openTab: (sessionId: string, options?: OpenTabOptions) => void
  /** Remove a session from open tabs. Returns the next active session ID. */
  closeTab: (sessionId: string) => string | null
  /** Set the active session. */
  setActive: (sessionId: string | null) => void
  /** Reorder tabs via drag-and-drop. */
  reorder: (fromIndex: number, toIndex: number) => void
  /** Yjs provider connection status. */
  status: 'connecting' | 'connected' | 'disconnected'
}

/**
 * Imperative read for keyboard handlers and other non-React callers.
 * Returns the current openTabs array and activeSessionId without subscribing.
 */
export function getTabSyncSnapshot(): {
  openTabs: string[]
  activeSessionId: string | null
} {
  if (!sharedDoc) return { openTabs: [], activeSessionId: null }
  return {
    openTabs: sharedDoc.getArray<string>('openTabs').toArray(),
    activeSessionId: (sharedDoc.getMap('workspace').get('activeSessionId') as string) ?? null,
  }
}

// Module-level Y.Doc reference for imperative reads (getTabSyncSnapshot).
let sharedDoc: Y.Doc | null = null
let sharedDocMountCount = 0

export function useTabSync(): UseTabSyncResult {
  const { data: session } = useSession() as {
    data: { user?: { id?: string } } | null | undefined
  }
  const userId = session?.user?.id ?? null

  // One Y.Doc per user, stable across renders.
  const doc = useMemo(() => {
    if (!userId) return null
    const d = new Y.Doc()
    d.guid = `user-settings:${userId}`
    return d
  }, [userId])

  // Track the shared doc reference for imperative access.
  useEffect(() => {
    if (!doc) return
    sharedDoc = doc
    sharedDocMountCount++
    return () => {
      sharedDocMountCount--
      if (sharedDocMountCount === 0) sharedDoc = null
    }
  }, [doc])

  const openTabsY = useMemo(() => doc?.getArray<string>('openTabs') ?? null, [doc])
  const tabProjectsY = useMemo(() => doc?.getMap<string>('tabProjects') ?? null, [doc])
  const workspaceY = useMemo(() => doc?.getMap('workspace') ?? null, [doc])

  const host = typeof window !== 'undefined' && window.location ? window.location.host : ''

  // y-partyserver provider — WS sync, auto-reconnect, hibernation-safe.
  useYProvider({
    host,
    room: userId ?? '',
    party: 'user-settings',
    doc: doc ?? undefined,
    options: { connect: Boolean(userId) },
  })

  // IndexedDB persistence for offline cold-start.
  useEffect(() => {
    if (!userId || !doc) return
    let idb: { destroy: () => void } | null = null
    import('y-indexeddb').then(({ IndexeddbPersistence }) => {
      idb = new IndexeddbPersistence(`user-settings:${userId}`, doc)
    })
    return () => {
      idb?.destroy()
    }
  }, [userId, doc])

  // Connection status tracking.
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  useEffect(() => {
    if (!doc) return
    const provider = (doc as any).wsProvider
    if (!provider) return
    const onStatus = (payload: { status?: string } | undefined) => {
      const next = payload?.status
      if (next === 'connected' || next === 'connecting' || next === 'disconnected') {
        setStatus(next)
      }
    }
    provider.on('status', onStatus as never)
    return () => provider.off('status', onStatus as never)
  }, [doc])

  // Reactive state from Y.Doc observers.
  const [openTabs, setOpenTabs] = useState<string[]>(() => openTabsY?.toArray() ?? [])
  const [activeSessionId, setActiveState] = useState<string | null>(
    () => (workspaceY?.get('activeSessionId') as string) ?? null,
  )

  useEffect(() => {
    if (!openTabsY) return
    const handler = () => setOpenTabs(openTabsY.toArray())
    openTabsY.observe(handler)
    setOpenTabs(openTabsY.toArray())
    return () => openTabsY.unobserve(handler)
  }, [openTabsY])

  useEffect(() => {
    if (!workspaceY) return
    const handler = () => {
      setActiveState((workspaceY.get('activeSessionId') as string) ?? null)
    }
    workspaceY.observe(handler)
    handler()
    return () => workspaceY.unobserve(handler)
  }, [workspaceY])

  // One-time migration: legacy localStorage activeTab.
  const migratedRef = useRef(false)
  useEffect(() => {
    if (!workspaceY || !openTabsY || migratedRef.current) return
    migratedRef.current = true
    if (!workspaceY.get('activeSessionId')) {
      const legacyActiveTab = localStorage.getItem('duraclaw-active-tab')
      if (legacyActiveTab) {
        const tabs = openTabsY.toArray()
        if (tabs.length > 0) {
          workspaceY.set('activeSessionId', tabs[0])
        }
        localStorage.removeItem('duraclaw-active-tab')
      }
    }
  }, [workspaceY, openTabsY])

  // Self-healing dedup: remove duplicate-project tabs using the Y.Map.
  // Runs reactively after Yjs sync so it cleans legacy state from both
  // IndexedDB and the server-side Y.Doc.
  // biome-ignore lint/correctness/useExhaustiveDependencies: openTabs dep triggers re-check after Yjs sync
  useEffect(() => {
    if (!doc || !openTabsY || !tabProjectsY) return
    const arr = openTabsY.toArray()
    if (arr.length < 2) return

    const projectIndices = new Map<string, number[]>()
    for (let i = 0; i < arr.length; i++) {
      const project = tabProjectsY.get(arr[i]) as string | undefined
      if (!project) continue
      const indices = projectIndices.get(project)
      if (indices) indices.push(i)
      else projectIndices.set(project, [i])
    }

    const toRemove: number[] = []
    for (const indices of projectIndices.values()) {
      if (indices.length > 1) {
        toRemove.push(...indices.slice(0, -1))
      }
    }
    if (toRemove.length === 0) return

    doc.transact(() => {
      for (const idx of toRemove.sort((a, b) => b - a)) {
        const removedId = openTabsY.get(idx)
        openTabsY.delete(idx, 1)
        // Clean up project mapping for removed entry.
        tabProjectsY.delete(removedId)
      }
    })
  }, [doc, openTabsY, tabProjectsY, openTabs])

  // ── Actions ─────────────────────────────────────────────────────────

  const openTab = useCallback(
    (sessionId: string, opts?: OpenTabOptions) => {
      const project = opts?.project
      const forceNewTab = opts?.forceNewTab ?? false
      if (!doc || !openTabsY || !tabProjectsY || !workspaceY) return

      doc.transact(() => {
        const arr = openTabsY.toArray()

        // Store project mapping (update even if tab exists — project
        // may not have been known on a previous openTab call).
        if (project) tabProjectsY.set(sessionId, project)

        // Already open — just activate.
        if (arr.includes(sessionId)) {
          workspaceY.set('activeSessionId', sessionId)
          return
        }

        // Resolve project: prefer explicit arg, fall back to Y.Map.
        const resolvedProject = project ?? (tabProjectsY.get(sessionId) as string | undefined)

        // One-tab-per-project: find and replace existing tab.
        if (!forceNewTab && resolvedProject) {
          const existingIdx = arr.findIndex(
            (id) => (tabProjectsY.get(id) as string | undefined) === resolvedProject,
          )
          if (existingIdx !== -1) {
            const oldId = arr[existingIdx]
            openTabsY.delete(existingIdx, 1)
            openTabsY.insert(existingIdx, [sessionId])
            // Clean up old mapping, but only if the old session isn't
            // elsewhere in the array (shouldn't be, but be safe).
            if (!openTabsY.toArray().includes(oldId)) {
              tabProjectsY.delete(oldId)
            }
            workspaceY.set('activeSessionId', sessionId)
            return
          }
        }

        // No conflict — append.
        openTabsY.push([sessionId])
        workspaceY.set('activeSessionId', sessionId)
      })
    },
    [doc, openTabsY, tabProjectsY, workspaceY],
  )

  const closeTab = useCallback(
    (sessionId: string): string | null => {
      if (!doc || !openTabsY || !tabProjectsY || !workspaceY) return null
      let nextActive: string | null = null
      doc.transact(() => {
        const arr = openTabsY.toArray()
        const idx = arr.indexOf(sessionId)
        if (idx === -1) return
        openTabsY.delete(idx, 1)
        tabProjectsY.delete(sessionId)
        const current = workspaceY.get('activeSessionId')
        if (current === sessionId) {
          const remaining = openTabsY.toArray()
          nextActive = remaining[Math.min(idx, remaining.length - 1)] ?? null
          workspaceY.set('activeSessionId', nextActive)
        }
      })
      return nextActive
    },
    [doc, openTabsY, tabProjectsY, workspaceY],
  )

  const setActive = useCallback(
    (sessionId: string | null) => {
      workspaceY?.set('activeSessionId', sessionId)
    },
    [workspaceY],
  )

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!doc || !openTabsY) return
      doc.transact(() => {
        const item = openTabsY.get(fromIndex)
        openTabsY.delete(fromIndex, 1)
        openTabsY.insert(toIndex, [item])
      })
    },
    [doc, openTabsY],
  )

  return { openTabs, activeSessionId, openTab, closeTab, setActive, reorder, status }
}
