/**
 * useNextModePrecondition — compute the next-mode advance button state for
 * one chain on the kanban (B9 precondition table).
 *
 * The table:
 *
 * | column         | next           | gate                                    |
 * |----------------|----------------|-----------------------------------------|
 * | backlog        | research       | `issueState !== 'closed'`               |
 * | research       | planning       | any completed research session          |
 * | planning       | implementation | spec-status `{exists, status:'approved'}` |
 * | implementation | verify         | any completed implementation session    |
 * | verify         | close          | vp-status `{exists:true}`               |
 * | done           | —              | (no next)                               |
 *
 * The spec-status / vp-status fetches are cached in a module-level map for
 * 30s — the hook invalidates a cache entry only on mount when no entry
 * exists or the cached entry is stale. Both checkPrecondition() (used by
 * drag-to-advance) and the hook share this cache.
 */

import { useEffect, useMemo, useState } from 'react'
import { useSessionsCollection } from '~/hooks/use-sessions-collection'
import type { ChainSummary, SpecStatusResponse, VpStatusResponse } from '~/lib/types'

export type NextMode = 'research' | 'planning' | 'implementation' | 'verify' | 'close' | null

export interface ChainPrecondition {
  nextMode: NextMode
  nextLabel: string
  canAdvance: boolean
  reason: string
  loading: boolean
}

interface CacheEntry {
  at: number
  data: SpecStatusResponse | VpStatusResponse
}

const CACHE_TTL_MS = 30_000
const statusCache = new Map<string, CacheEntry>()

function cacheGet<T extends SpecStatusResponse | VpStatusResponse>(key: string): T | null {
  const entry = statusCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    statusCache.delete(key)
    return null
  }
  return entry.data as T
}

async function cachedFetch<T extends SpecStatusResponse | VpStatusResponse>(
  key: string,
  url: string,
): Promise<T> {
  const cached = cacheGet<T>(key)
  if (cached) return cached
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      const miss = { exists: false } as T
      statusCache.set(key, { at: Date.now(), data: miss })
      return miss
    }
    const data = (await resp.json()) as T
    statusCache.set(key, { at: Date.now(), data })
    return data
  } catch {
    const miss = { exists: false } as T
    statusCache.set(key, { at: Date.now(), data: miss })
    return miss
  }
}

function nextFor(column: ChainSummary['column']): { mode: NextMode; label: string } {
  switch (column) {
    case 'backlog':
      return { mode: 'research', label: 'research' }
    case 'research':
      return { mode: 'planning', label: 'planning' }
    case 'planning':
      return { mode: 'implementation', label: 'implementation' }
    case 'implementation':
      return { mode: 'verify', label: 'verify' }
    case 'verify':
      return { mode: 'close', label: 'close' }
    default:
      return { mode: null, label: '' }
  }
}

/**
 * Pure precondition check — shared by the hook and the drag-to-advance
 * handler. Session filtering happens at the caller; we only need the
 * filtered list for the session-based modes.
 */
export async function checkPrecondition(
  chain: ChainSummary,
  sessionsForChain: readonly { kataMode?: string | null; status: string }[],
): Promise<{ canAdvance: boolean; reason: string; nextMode: NextMode }> {
  const { mode } = nextFor(chain.column)
  if (mode === null) {
    return { canAdvance: false, reason: 'Chain already done', nextMode: null }
  }

  if (mode === 'research') {
    if (chain.issueState === 'closed') {
      return { canAdvance: false, reason: 'Issue is closed', nextMode: mode }
    }
    return { canAdvance: true, reason: '', nextMode: mode }
  }

  if (mode === 'planning') {
    const ok = sessionsForChain.some((s) => s.kataMode === 'research' && s.status === 'completed')
    return {
      canAdvance: ok,
      reason: ok ? '' : 'No completed research session',
      nextMode: mode,
    }
  }

  if (mode === 'implementation') {
    const spec = await cachedFetch<SpecStatusResponse>(
      `spec:${chain.issueNumber}`,
      `/api/chains/${chain.issueNumber}/spec-status`,
    )
    if (!spec.exists) {
      return { canAdvance: false, reason: 'Spec not found', nextMode: mode }
    }
    if (spec.status !== 'approved') {
      return { canAdvance: false, reason: 'Spec not yet approved', nextMode: mode }
    }
    return { canAdvance: true, reason: '', nextMode: mode }
  }

  if (mode === 'verify') {
    const ok = sessionsForChain.some(
      (s) => s.kataMode === 'implementation' && s.status === 'completed',
    )
    return {
      canAdvance: ok,
      reason: ok ? '' : 'No completed implementation session',
      nextMode: mode,
    }
  }

  if (mode === 'close') {
    const vp = await cachedFetch<VpStatusResponse>(
      `vp:${chain.issueNumber}`,
      `/api/chains/${chain.issueNumber}/vp-status`,
    )
    if (!vp.exists) {
      return { canAdvance: false, reason: 'VP evidence not found', nextMode: mode }
    }
    return { canAdvance: true, reason: '', nextMode: mode }
  }

  return { canAdvance: false, reason: '', nextMode: mode }
}

export function useNextModePrecondition(chain: ChainSummary): ChainPrecondition {
  const { sessions } = useSessionsCollection({ includeArchived: true })

  const sessionsForChain = useMemo(
    () => sessions.filter((s) => s.kataIssue === chain.issueNumber),
    [sessions, chain.issueNumber],
  )

  const { mode: nextMode, label: nextLabel } = nextFor(chain.column)

  const [state, setState] = useState<{
    canAdvance: boolean
    reason: string
    loading: boolean
  }>({ canAdvance: false, reason: '', loading: nextMode !== null })

  useEffect(() => {
    if (nextMode === null) {
      setState({ canAdvance: false, reason: '', loading: false })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    checkPrecondition(chain, sessionsForChain).then((res) => {
      if (cancelled) return
      setState({ canAdvance: res.canAdvance, reason: res.reason, loading: false })
    })
    return () => {
      cancelled = true
    }
    // sessionsForChain changes when the sessions list changes; include the
    // column so column-flip also re-evaluates.
  }, [chain, sessionsForChain, nextMode])

  return {
    nextMode,
    nextLabel,
    canAdvance: state.canAdvance,
    reason: state.reason,
    loading: state.loading,
  }
}
