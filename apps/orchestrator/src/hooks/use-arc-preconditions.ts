/**
 * useNextModePrecondition — compute the next-mode advance button state for
 * one arc on the kanban (originally GH#82 B9 precondition table).
 *
 * Renamed from `use-chain-preconditions.ts` in GH#116 P1.4. The
 * semantics are unchanged; field accesses ported to the post-#116
 * `ArcSummary` shape:
 *
 *   - `arc.externalRef?.id` (was: `chain.issueNumber`)
 *   - `arc.externalRef.provider === 'github'` "open vs closed" gate has
 *     no direct port — the new arc.status carries `draft|open|closed|archived`.
 *   - `arc.sessions[].mode` (was: `chain.sessions[].kataMode`)
 *   - `deriveColumn(arc.sessions, arc.status)` instead of `chain.column`
 *
 * The table:
 *
 * | column         | next           | gate                                    |
 * |----------------|----------------|-----------------------------------------|
 * | backlog        | research       | `arc.status !== 'closed'`               |
 * | research       | planning       | any completed research session          |
 * | planning       | implementation | spec-status `{exists, status:'approved'}` |
 * | implementation | verify         | any completed implementation session    |
 * | verify         | close          | vp-status `{exists:true}`               |
 * | done           | —              | (no next)                               |
 *
 * The spec-status / vp-status fetches are cached in a module-level map
 * for 30s — the hook invalidates a cache entry only on mount when no
 * entry exists or the cached entry is stale. Both `checkPrecondition()`
 * (used by drag-to-advance) and the hook share this cache.
 *
 * Endpoint paths point at `/api/arcs/:id/spec-status` / `vp-status`
 * (P3 ships these — until then the call falls back to `{exists:false}`
 * via `cachedFetch`'s graceful-degrade, keeping the precondition
 * red-but-not-poisoned).
 */

import { useEffect, useMemo, useState } from 'react'
import { deriveColumn, type KanbanColumn } from '~/lib/arcs'
import { isChainSessionCompleted } from '~/lib/chains'
import type { ArcSummary, SpecStatusResponse, VpStatusResponse } from '~/lib/types'

export type NextMode = 'research' | 'planning' | 'implementation' | 'verify' | 'close' | null

export interface ArcPrecondition {
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
  // Only cache successful responses. A transient gateway hiccup (network
  // error, 4xx/5xx) used to poison the cache for 30s with `{exists:false}`,
  // producing a sticky "Spec not found" / "VP evidence not found" stall
  // even after the gateway recovered. Server-side auto-advance was already
  // hardened against this same failure mode (see `lib/auto-advance.ts:88`);
  // this brings the client gate into line. The render returns `{exists:false}`
  // for THIS call so the UI degrades gracefully — but the next render
  // retries against a live fetch.
  try {
    const resp = await fetch(url)
    if (!resp.ok) return { exists: false } as T
    const data = (await resp.json()) as T
    statusCache.set(key, { at: Date.now(), data })
    return data
  } catch {
    return { exists: false } as T
  }
}

function nextFor(column: KanbanColumn): { mode: NextMode; label: string } {
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

/** Derive a project-name string for the spec-status / vp-status query
 *  param. Mirrors the legacy chain-side derivation (sessions[0].project,
 *  fallback to worktreeReservation basename) but reads from the arc's
 *  worktreeReservation `worktree` field (path string). */
function deriveProject(arc: ArcSummary): string | null {
  const wt = arc.worktreeReservation?.worktree
  if (typeof wt === 'string' && wt.length > 0) {
    return wt.split('/').pop() ?? wt
  }
  return null
}

/** Stable key for spec/vp-status cache entries. Prefers `arc.id`
 *  (the new canonical handle) and falls back to the externalRef id
 *  for arcs whose id is not surfaced (shouldn't happen post-#116). */
function arcCacheKey(arc: ArcSummary): string {
  return arc.id
}

/**
 * Pure precondition check — shared by the hook and the drag-to-advance
 * handler. Reads everything it needs from the `ArcSummary` directly.
 */
export async function checkPrecondition(
  arc: ArcSummary,
): Promise<{ canAdvance: boolean; reason: string; nextMode: NextMode }> {
  const column = deriveColumn(arc.sessions, arc.status)
  const { mode } = nextFor(column)
  if (mode === null) {
    return { canAdvance: false, reason: 'Arc already done', nextMode: null }
  }

  if (mode === 'research') {
    if (arc.status === 'closed' || arc.status === 'archived') {
      return { canAdvance: false, reason: 'Arc is closed', nextMode: mode }
    }
    return { canAdvance: true, reason: '', nextMode: mode }
  }

  if (mode === 'planning') {
    const ok = arc.sessions.some(
      (s) =>
        s.mode === 'research' &&
        isChainSessionCompleted({ status: s.status, lastActivity: s.lastActivity ?? null }),
    )
    return {
      canAdvance: ok,
      reason: ok ? '' : 'No completed research session',
      nextMode: mode,
    }
  }

  if (mode === 'implementation') {
    const project = deriveProject(arc)
    if (!project) {
      return { canAdvance: false, reason: 'No project context for arc', nextMode: mode }
    }
    const arcKey = arcCacheKey(arc)
    const spec = await cachedFetch<SpecStatusResponse>(
      `spec:${arcKey}:${project}`,
      `/api/arcs/${encodeURIComponent(arc.id)}/spec-status?project=${encodeURIComponent(project)}`,
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
    const ok = arc.sessions.some(
      (s) =>
        s.mode === 'implementation' &&
        isChainSessionCompleted({ status: s.status, lastActivity: s.lastActivity ?? null }),
    )
    return {
      canAdvance: ok,
      reason: ok ? '' : 'No completed implementation session',
      nextMode: mode,
    }
  }

  if (mode === 'close') {
    const project = deriveProject(arc)
    if (!project) {
      return { canAdvance: false, reason: 'No project context for arc', nextMode: mode }
    }
    const arcKey = arcCacheKey(arc)
    const vp = await cachedFetch<VpStatusResponse>(
      `vp:${arcKey}:${project}`,
      `/api/arcs/${encodeURIComponent(arc.id)}/vp-status?project=${encodeURIComponent(project)}`,
    )
    if (!vp.exists) {
      return { canAdvance: false, reason: 'VP evidence not found', nextMode: mode }
    }
    return { canAdvance: true, reason: '', nextMode: mode }
  }

  return { canAdvance: false, reason: '', nextMode: mode }
}

export function useNextModePrecondition(arc: ArcSummary): ArcPrecondition {
  const column = useMemo(() => deriveColumn(arc.sessions, arc.status), [arc])
  const { mode: nextMode, label: nextLabel } = nextFor(column)

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
    checkPrecondition(arc).then((res) => {
      if (cancelled) return
      setState({ canAdvance: res.canAdvance, reason: res.reason, loading: false })
    })
    return () => {
      cancelled = true
    }
    // re-evaluate whenever the arc changes (sessions / status) so column
    // flips trigger a re-check.
  }, [arc, nextMode])

  return {
    nextMode,
    nextLabel,
    canAdvance: state.canAdvance,
    reason: state.reason,
    loading: state.loading,
  }
}
