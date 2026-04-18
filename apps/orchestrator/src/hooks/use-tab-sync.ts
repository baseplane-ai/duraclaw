/**
 * useTabSync — Yjs-backed tab state, synced cross-device via UserSettingsDO.
 *
 * The Y.Doc holds:
 *   - Y.Array<string> "openTabs"   — ordered session IDs
 *   - Y.Map "workspace"            — { activeSessionId: string | null }
 *
 * Client-side persistence: y-indexeddb gives offline cold-start so the tab bar
 * renders immediately before the WS connects. CRDT merge handles any drift
 * between IndexedDB cache and server state.
 *
 * One-tab-per-project: when a `projectResolver` is provided, `openTab`
 * automatically replaces an existing tab for the same project instead of
 * opening a duplicate. This is the single enforcement point — callers never
 * need to check for project conflicts themselves.
 *
 * Replaces: userTabsCollection, useActiveTab, ensureTabForSession, tab CRUD
 * API endpoints, and the entire optimistic-insert / server-dedup race surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useYProvider from 'y-partyserver/react'
import * as Y from 'yjs'
import { useSession } from '~/lib/auth-client'

export interface OpenTabOptions {
  /** Activate the tab after opening. Default: true. */
  activate?: boolean
  /** Force a new tab even if another tab for the same project exists. */
  forceNewTab?: boolean
}

export interface UseTabSyncOptions {
  /**
   * Maps sessionId → project name. When provided, openTab enforces
   * one-tab-per-project: if a tab for the same project already exists,
   * the new session replaces it in-place.
   */
  projectResolver?: (sessionId: string) => string | undefined
}

export interface UseTabSyncResult {
  /** Ordered list of open session IDs (reactive). */
  openTabs: string[]
  /** Currently focused session ID (reactive). */
  activeSessionId: string | null
  /**
   * Add a session to open tabs. Idempotent by session ID; when a
   * projectResolver is configured, also enforces one-tab-per-project
   * (replaces existing tab for same project unless forceNewTab is set).
   */
  openTab: (sessionId: string, options?: OpenTabOptions) => void
  /** Replace one session with another in the same tab position. */
  replaceTab: (oldSessionId: string, newSessionId: string) => void
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
// Set by the first useTabSync mount; cleared on unmount if no other mounts remain.
let sharedDoc: Y.Doc | null = null
let sharedDocMountCount = 0

export function useTabSync(options?: UseTabSyncOptions): UseTabSyncResult {
  // Store resolver in a ref so it doesn't destabilize callbacks.
  const projectResolverRef = useRef(options?.projectResolver)
  projectResolverRef.current = options?.projectResolver
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
  const workspaceY = useMemo(() => doc?.getMap('workspace') ?? null, [doc])

  const host = typeof window !== 'undefined' && window.location ? window.location.host : ''

  // y-partyserver provider — WS sync, auto-reconnect, hibernation-safe.
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
    // Dynamic import to avoid SSR issues — y-indexeddb uses browser APIs.
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
  const [openTabs, setOpenTabs] = useState<string[]>(() => openTabsY?.toArray() ?? [])
  const [activeSessionId, setActiveState] = useState<string | null>(
    () => (workspaceY?.get('activeSessionId') as string) ?? null,
  )

  useEffect(() => {
    if (!openTabsY) return
    const handler = () => setOpenTabs(openTabsY.toArray())
    openTabsY.observe(handler)
    // Sync initial state (IndexedDB may have hydrated by now).
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

  // One-time migration: if Y.Doc has no active session but localStorage does,
  // carry the legacy activeTabId forward then delete the legacy key.
  const migratedRef = useRef(false)
  useEffect(() => {
    if (!workspaceY || !openTabsY || migratedRef.current) return
    migratedRef.current = true
    if (!workspaceY.get('activeSessionId')) {
      const legacyActiveTab = localStorage.getItem('duraclaw-active-tab')
      if (legacyActiveTab) {
        // We can't translate tab ID to session ID without the old collection,
        // so just activate the first open tab.
        const tabs = openTabsY.toArray()
        if (tabs.length > 0) {
          workspaceY.set('activeSessionId', tabs[0])
        }
        localStorage.removeItem('duraclaw-active-tab')
      }
    }
  }, [workspaceY, openTabsY])

  // ── Actions ─────────────────────────────────────────────────────────

  const openTab = useCallback(
    (sessionId: string, opts?: OpenTabOptions) => {
      const activate = opts?.activate ?? true
      const forceNewTab = opts?.forceNewTab ?? false
      if (!doc || !openTabsY || !workspaceY) return
      doc.transact(() => {
        const arr = openTabsY.toArray()

        // Already open — just activate.
        if (arr.includes(sessionId)) {
          if (activate) workspaceY.set('activeSessionId', sessionId)
          return
        }

        // One-tab-per-project: if a resolver is configured and another tab
        // for the same project exists, replace it in-place.
        const resolver = projectResolverRef.current
        if (!forceNewTab && resolver) {
          const project = resolver(sessionId)
          if (project) {
            const existingIdx = arr.findIndex((id) => resolver(id) === project)
            if (existingIdx !== -1) {
              openTabsY.delete(existingIdx, 1)
              openTabsY.insert(existingIdx, [sessionId])
              if (activate) workspaceY.set('activeSessionId', sessionId)
              return
            }
          }
        }

        // No conflict — append.
        openTabsY.push([sessionId])
        if (activate) workspaceY.set('activeSessionId', sessionId)
      })
    },
    [doc, openTabsY, workspaceY],
  )

  const replaceTab = useCallback(
    (oldSessionId: string, newSessionId: string) => {
      if (!doc || !openTabsY || !workspaceY) return
      doc.transact(() => {
        const arr = openTabsY.toArray()
        const idx = arr.indexOf(oldSessionId)
        if (idx === -1) {
          // Old session not found — just append.
          if (!arr.includes(newSessionId)) openTabsY.push([newSessionId])
        } else {
          // Replace in-place: delete old, insert new at same position.
          openTabsY.delete(idx, 1)
          openTabsY.insert(idx, [newSessionId])
        }
        workspaceY.set('activeSessionId', newSessionId)
      })
    },
    [doc, openTabsY, workspaceY],
  )

  const closeTab = useCallback(
    (sessionId: string): string | null => {
      if (!doc || !openTabsY || !workspaceY) return null
      let nextActive: string | null = null
      doc.transact(() => {
        const arr = openTabsY.toArray()
        const idx = arr.indexOf(sessionId)
        if (idx === -1) return
        openTabsY.delete(idx, 1)
        // If closing the active tab, pick adjacent.
        const current = workspaceY.get('activeSessionId')
        if (current === sessionId) {
          const remaining = openTabsY.toArray()
          nextActive = remaining[Math.min(idx, remaining.length - 1)] ?? null
          workspaceY.set('activeSessionId', nextActive)
        }
      })
      return nextActive
    },
    [doc, openTabsY, workspaceY],
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

  return { openTabs, activeSessionId, openTab, replaceTab, closeTab, setActive, reorder, status }
}
