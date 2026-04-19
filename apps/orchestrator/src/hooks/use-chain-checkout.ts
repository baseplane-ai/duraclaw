/**
 * useChainCheckout — thin client wrapper around the P2-U2 worktree
 * reservation APIs (GH#16 Feature 3E):
 *
 * - `POST /api/chains/:issue/checkout`      → 200 `{ reservation }` | 409 `{ conflict, message }`
 * - `POST /api/chains/:issue/release`       → 200 `{ released, count }` | 404
 * - `POST /api/chains/:issue/force-release` → 200 | 403 `{ message, staleAfterDays, lastActivity }`
 *
 * No retries, no optimistic state — callers own orchestration. The returned
 * object is memoised so callback refs stay stable across renders.
 */

import { useMemo } from 'react'
import type { WorktreeReservation } from '~/lib/types'

export interface ChainCheckoutResult {
  ok: boolean
  reservation?: WorktreeReservation
  conflict?: WorktreeReservation
  error?: string
}

export interface ChainReleaseResult {
  ok: boolean
  count?: number
  error?: string
}

export interface ChainForceReleaseResult {
  ok: boolean
  error?: string
}

export interface UseChainCheckoutResult {
  checkout: (
    issueNumber: number,
    worktree: string,
    modeAtCheckout?: string,
  ) => Promise<ChainCheckoutResult>
  release: (issueNumber: number) => Promise<ChainReleaseResult>
  forceRelease: (issueNumber: number, worktree?: string) => Promise<ChainForceReleaseResult>
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

export function useChainCheckout(): UseChainCheckoutResult {
  return useMemo<UseChainCheckoutResult>(
    () => ({
      async checkout(issueNumber, worktree, modeAtCheckout) {
        try {
          const { status, data } = await postJson(`/api/chains/${issueNumber}/checkout`, {
            worktree,
            modeAtCheckout,
          })
          if (status === 200 && data && 'reservation' in data) {
            return { ok: true, reservation: data.reservation as WorktreeReservation }
          }
          if (status === 409 && data && 'conflict' in data) {
            return {
              ok: false,
              conflict: data.conflict as WorktreeReservation,
              error: typeof data.message === 'string' ? data.message : 'Worktree already held',
            }
          }
          return {
            ok: false,
            error:
              data && typeof data.message === 'string'
                ? data.message
                : `checkout failed (${status})`,
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },

      async release(issueNumber) {
        try {
          const { status, data } = await postJson(`/api/chains/${issueNumber}/release`, {})
          if (status === 200) {
            const count =
              data && typeof data.count === 'number' ? (data.count as number) : undefined
            return { ok: true, count }
          }
          return {
            ok: false,
            error:
              data && typeof data.message === 'string'
                ? data.message
                : `release failed (${status})`,
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },

      async forceRelease(issueNumber, worktree) {
        try {
          const body: Record<string, unknown> = { confirmation: true }
          if (worktree) body.worktree = worktree
          const { status, data } = await postJson(`/api/chains/${issueNumber}/force-release`, body)
          if (status === 200) return { ok: true }
          return {
            ok: false,
            error:
              data && typeof data.message === 'string'
                ? data.message
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
