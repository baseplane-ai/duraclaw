/**
 * useTabSync — Yjs-backed tab state, synced cross-device via UserSettingsDO.
 *
 * Y.Doc schema:
 *   - Y.Map "openTabs"  — key: sessionId, value: JSON { project, order }
 *   - Y.Map "workspace" — { activeSessionId: string | null }
 *
 * Why Y.Map instead of Y.Array:
 * Y.Array is a list, not a set. Every push() creates a unique CRDT item.
 * When the deep-link effect fires before IndexedDB hydration, push() into
 * the empty array creates a NEW operation. When IndexedDB then loads the
 * old entries, CRDT merge keeps both — duplicating on every refresh.
 *
 * Y.Map keys are inherently unique. set("X", ...) from two sources (local
 * + IndexedDB) converges to one entry via last-writer-wins. The hydration
 * race becomes a non-issue. No ready gate, no dedup effect needed.
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

export interface UseTabSyncResult {
  /** Ordered list of open session IDs (reactive, sorted by order). */
  openTabs: string[]
  /** Currently focused session ID (reactive). */
  activeSessionId: string | null
  /**
   * Open or activate a tab. Idempotent — Y.Map keys can't duplicate.
   * When a project is provided, enforces one-tab-per-project (removes
   * existing tab for the same project unless forceNewTab is set).
   */
  openTab: (sessionId: string, options?: OpenTabOptions) => void
  /** Remove a session from open tabs. Returns the next active session ID. */
  closeTab: (sessionId: string) => string | null
  /** Set the active session. */
  setActive: (sessionId: string | null) => void
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
    activeSessionId: (sharedDoc.getMap('workspace').get('activeSessionId') as string) ?? null,
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

  // "tabs" (Y.Map) replaces the old "openTabs" (Y.Array). Different name
  // avoids Yjs type conflicts. Server-side migration in UserSettingsDO
  // copies Y.Array "openTabs" → Y.Map "tabs" on first load.
  const tabsY = useMemo(() => doc?.getMap<string>('tabs') ?? null, [doc])
  const workspaceY = useMemo(() => doc?.getMap('workspace') ?? null, [doc])

  const host = typeof window !== 'undefined' && window.location ? window.location.host : ''

  const provider = useYProvider({
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

  // Reactive state from Y.Doc observers.
  const [openTabs, setOpenTabs] = useState<string[]>(() => (tabsY ? sortedTabIds(tabsY) : []))
  const [activeSessionId, setActiveState] = useState<string | null>(
    () => (workspaceY?.get('activeSessionId') as string) ?? null,
  )

  useEffect(() => {
    if (!tabsY) return
    const handler = () => setOpenTabs(sortedTabIds(tabsY))
    tabsY.observe(handler)
    setOpenTabs(sortedTabIds(tabsY))
    return () => tabsY.unobserve(handler)
  }, [tabsY])

  useEffect(() => {
    if (!workspaceY) return
    const handler = () => {
      setActiveState((workspaceY.get('activeSessionId') as string) ?? null)
    }
    workspaceY.observe(handler)
    handler()
    return () => workspaceY.unobserve(handler)
  }, [workspaceY])

  // ── Actions ─────────────────────────────────────────────────────────

  const openTab = useCallback(
    (sessionId: string, opts?: OpenTabOptions) => {
      const project = opts?.project
      const forceNewTab = opts?.forceNewTab ?? false
      if (!doc || !tabsY || !workspaceY) return

      doc.transact(() => {
        const existing = tabsY.get(sessionId)

        if (existing) {
          // Already open — update project if newly known, then activate.
          if (project) {
            const entry = parseEntry(existing)
            if (entry.project !== project) {
              tabsY.set(sessionId, JSON.stringify({ ...entry, project }))
            }
          }
          workspaceY.set('activeSessionId', sessionId)
          return
        }

        // Resolve project for one-tab-per-project check.
        if (!forceNewTab && project) {
          // Find existing tab for the same project and remove it.
          tabsY.forEach((val, key) => {
            const entry = parseEntry(val)
            if (entry.project === project) {
              tabsY.delete(key)
            }
          })
        }

        // Compute order: after the last existing tab.
        let maxOrder = 0
        tabsY.forEach((val) => {
          const entry = parseEntry(val)
          if (entry.order > maxOrder) maxOrder = entry.order
        })

        tabsY.set(sessionId, JSON.stringify({ project, order: maxOrder + 1 }))
        workspaceY.set('activeSessionId', sessionId)
      })
    },
    [doc, tabsY, workspaceY],
  )

  const closeTab = useCallback(
    (sessionId: string): string | null => {
      if (!doc || !tabsY || !workspaceY) return null
      let nextActive: string | null = null
      doc.transact(() => {
        if (!tabsY.has(sessionId)) return
        const sorted = sortedTabIds(tabsY)
        const idx = sorted.indexOf(sessionId)
        tabsY.delete(sessionId)

        const current = workspaceY.get('activeSessionId')
        if (current === sessionId) {
          const remaining = sorted.filter((id) => id !== sessionId)
          nextActive = remaining[Math.min(idx, remaining.length - 1)] ?? null
          workspaceY.set('activeSessionId', nextActive)
        }
      })
      return nextActive
    },
    [doc, tabsY, workspaceY],
  )

  const setActive = useCallback(
    (sessionId: string | null) => {
      workspaceY?.set('activeSessionId', sessionId)
    },
    [workspaceY],
  )

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!doc || !tabsY) return
      doc.transact(() => {
        const sorted = sortedTabIds(tabsY)
        if (fromIndex < 0 || fromIndex >= sorted.length) return
        if (toIndex < 0 || toIndex >= sorted.length) return

        // Remove from old position, insert at new.
        const moved = sorted.splice(fromIndex, 1)[0]
        sorted.splice(toIndex, 0, moved)

        // Reassign sequential order values.
        for (let i = 0; i < sorted.length; i++) {
          const id = sorted[i]
          const entry = parseEntry(tabsY.get(id))
          tabsY.set(id, JSON.stringify({ ...entry, order: i + 1 }))
        }
      })
    },
    [doc, tabsY],
  )

  return { openTabs, activeSessionId, openTab, closeTab, setActive, reorder, status }
}
