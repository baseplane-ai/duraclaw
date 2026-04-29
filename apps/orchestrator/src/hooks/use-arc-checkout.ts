/**
 * useArcCheckout — thin client wrapper around the GH#115 `/api/worktrees/*`
 * primitives, surfaced under the legacy "checkout / release / force-release"
 * verbs that today's kanban + arc-status-item flows expect.
 *
 * Renamed from `useChainCheckout` in GH#116 P1.4. The endpoints moved
 * with #115's worktree-as-first-class-resource ship: per-issue routes
 * (`/api/chains/:issue/checkout|release|force-release`) are gone. The
 * live primitives are:
 *
 *   - `POST /api/worktrees {kind:'fresh', reservedBy:{kind:'arc', id}}` → 200 row | 503 pool_exhausted
 *   - `POST /api/worktrees/:id/release` → 200 | 403 not_owner | 404
 *   - `DELETE /api/worktrees/:id` (admin only) → 204
 *
 * The `forceRelease` here maps onto admin DELETE — non-admin users see
 * a 403 from the server, which surfaces to the caller as
 * `{ok:false, error:...}`.
 *
 * Note: this hook is identifier/endpoint-only; UX shape (pool-exhausted
 * conflict surface, error messages) intentionally mirrors the legacy
 * `ChainCheckoutResult` so call sites in the kanban refactor in P1.4
 * compile against a near-identical type.
 */

import { useMemo } from 'react'

/**
 * Worktree DTO returned by `/api/worktrees/*`. Subset of the columns
 * surfaced via `rowToDto` in `apps/orchestrator/src/api/index.ts`.
 */
export interface WorktreeDto {
  id: string
  path: string | null
  branch: string | null
  status: string
  reservedBy: { kind: string; id: number | string } | null
  ownerId: string | null
  releasedAt: number | null
  lastTouchedAt: number
  stale: boolean
}

export interface ArcCheckoutResult {
  ok: boolean
  /** The freshly-reserved worktree row on success. */
  reservation?: WorktreeDto
  /**
   * Pool-exhausted indicator (port of the legacy `conflict` field). When
   * the worktree pool has no free clones, `reservation` is absent and
   * `error` carries the `hint` from the API. The caller can present the
   * "no worktrees free" state without a structural conflict object.
   */
  poolExhausted?: { freeCount: number; totalCount: number; hint: string }
  error?: string
}

export interface ArcReleaseResult {
  ok: boolean
  error?: string
}

export interface ArcForceReleaseResult {
  ok: boolean
  error?: string
}

export interface UseArcCheckoutResult {
  /**
   * Reserve a fresh worktree for an arc. Maps onto `POST /api/worktrees`.
   * The legacy `(issueNumber, worktree, modeAtCheckout)` signature is
   * gone — worktrees are pool-allocated under #115, callers no longer
   * pick a specific clone.
   */
  checkout: (arcId: string | number) => Promise<ArcCheckoutResult>
  /** Release a worktree by its primary key (the FK `arcs.worktreeId`). */
  release: (worktreeId: string) => Promise<ArcReleaseResult>
  /**
   * Force-release a worktree by primary key. Admin-only on the server
   * (DELETE /api/worktrees/:id); non-admin callers receive
   * `error:'Forbidden'`.
   */
  forceRelease: (worktreeId: string) => Promise<ArcForceReleaseResult>
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  let data: Record<string, unknown> | null = null
  try {
    data = (await resp.json()) as Record<string, unknown>
  } catch {
    data = null
  }
  return { status: resp.status, data }
}

async function deleteRequest(
  url: string,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const resp = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  })
  let data: Record<string, unknown> | null = null
  try {
    data = (await resp.json()) as Record<string, unknown>
  } catch {
    data = null
  }
  return { status: resp.status, data }
}

export function useArcCheckout(): UseArcCheckoutResult {
  return useMemo<UseArcCheckoutResult>(
    () => ({
      async checkout(arcId) {
        try {
          const { status, data } = await postJson('/api/worktrees', {
            kind: 'fresh',
            reservedBy: { kind: 'arc', id: arcId },
          })
          if (status === 200 && data && typeof data.id === 'string') {
            return { ok: true, reservation: data as unknown as WorktreeDto }
          }
          if (status === 503 && data && data.error === 'pool_exhausted') {
            const freeCount = typeof data.freeCount === 'number' ? data.freeCount : 0
            const totalCount = typeof data.totalCount === 'number' ? data.totalCount : 0
            const hint = typeof data.hint === 'string' ? data.hint : 'pool exhausted'
            return {
              ok: false,
              poolExhausted: { freeCount, totalCount, hint },
              error: hint,
            }
          }
          return {
            ok: false,
            error:
              data && typeof data.error === 'string' ? data.error : `checkout failed (${status})`,
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },

      async release(worktreeId) {
        try {
          const { status, data } = await postJson(
            `/api/worktrees/${encodeURIComponent(worktreeId)}/release`,
            {},
          )
          if (status === 200) return { ok: true }
          return {
            ok: false,
            error:
              data && typeof data.error === 'string' ? data.error : `release failed (${status})`,
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },

      async forceRelease(worktreeId) {
        try {
          const { status, data } = await deleteRequest(
            `/api/worktrees/${encodeURIComponent(worktreeId)}`,
          )
          if (status === 200 || status === 204) return { ok: true }
          if (status === 403) {
            return { ok: false, error: 'Forbidden (admin-only)' }
          }
          return {
            ok: false,
            error:
              data && typeof data.error === 'string'
                ? data.error
                : `force-release failed (${status})`,
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),
    [],
  )
}
