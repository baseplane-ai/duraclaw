/**
 * useChainAutoAdvance — read + toggle the auto-advance preference for a
 * single chain.
 *
 * Extracted from `ChainStatusItem`'s popover in GH#82 so the kanban card
 * can expose the same toggle without forcing the user to open a session's
 * StatusBar first (which required a session to already exist — circular
 * dependency for backlog / freshly-promoted chains).
 *
 * Wire-up:
 *   - Reads the live `userPreferencesCollection` row (synced via
 *     UserSettingsDO). Effective value = per-chain override ?? global
 *     default (see `effectiveAutoAdvance` below; identical precedence to
 *     `auto-advance.ts:readAutoAdvancePref`).
 *   - `toggle()` PUTs `/api/preferences` with the merged `chains` JSON.
 *     The server echo lands on the synced collection via loopback, so
 *     neither call site needs an optimistic handler.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useCallback, useMemo } from 'react'
import { userPreferencesCollection } from '~/db/user-preferences-collection'
import { parseJsonField } from '~/lib/json'
import { apiUrl } from '~/lib/platform'
import type { UserPreferencesRow } from '~/lib/types'

type PerChainPrefs = Record<string, { autoAdvance?: boolean }>

interface UseChainAutoAdvanceResult {
  /** Effective "is auto-advance on" for this chain. */
  enabled: boolean
  /** True when a per-chain override exists (else falls back to the global default). */
  hasOverride: boolean
  /** Flip the per-chain override. Fire-and-forget; logs on network error. */
  toggle: () => Promise<void>
}

export function readChainPrefs(row: UserPreferencesRow | null | undefined): {
  perChain: PerChainPrefs
  defaultOn: boolean
} {
  if (!row) return { perChain: {}, defaultOn: false }
  const perChain = parseJsonField<PerChainPrefs>(row.chainsJson ?? null) ?? {}
  const defaultOn = row.defaultChainAutoAdvance === true
  return { perChain, defaultOn }
}

export function effectiveAutoAdvance(
  perChain: PerChainPrefs,
  defaultOn: boolean,
  issueNumber: number,
): boolean {
  const override = perChain[String(issueNumber)]?.autoAdvance
  if (typeof override === 'boolean') return override
  return defaultOn
}

export function useChainAutoAdvance(issueNumber: number): UseChainAutoAdvanceResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: prefsData } = useLiveQuery(userPreferencesCollection as any)

  const prefsRow = useMemo<UserPreferencesRow | null>(() => {
    if (!prefsData) return null
    const arr = prefsData as UserPreferencesRow[]
    return arr[0] ?? null
  }, [prefsData])

  const { perChain, defaultOn } = useMemo(() => readChainPrefs(prefsRow), [prefsRow])
  const enabled = effectiveAutoAdvance(perChain, defaultOn, issueNumber)
  const hasOverride = typeof perChain[String(issueNumber)]?.autoAdvance === 'boolean'

  const toggle = useCallback(async () => {
    const next: PerChainPrefs = {
      ...perChain,
      [String(issueNumber)]: { autoAdvance: !enabled },
    }
    try {
      const resp = await fetch(apiUrl('/api/preferences'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chains: next }),
      })
      if (!resp.ok) {
        console.warn('[useChainAutoAdvance] prefs PUT failed', resp.status)
      }
    } catch (err) {
      console.warn('[useChainAutoAdvance] prefs PUT threw', err)
    }
  }, [enabled, issueNumber, perChain])

  return { enabled, hasOverride, toggle }
}
