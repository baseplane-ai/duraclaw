/**
 * useArcAutoAdvance — read + toggle the auto-advance preference for a
 * single arc.
 *
 * Extracted from `ArcStatusItem`'s popover (originally GH#82) so the
 * kanban card can expose the same toggle without forcing the user to
 * open a session's StatusBar first (which required a session to already
 * exist — circular dependency for backlog / freshly-promoted arcs).
 *
 * Renamed from `useChainAutoAdvance` in GH#116 P1.4. The keying surface
 * is still `issueNumber` and the wire shape (`chains` JSON, `chainsJson`
 * column, `defaultChainAutoAdvance` global) is unchanged — preference-
 * shape migration is out of scope for the identifier sweep.
 *
 * Wire-up:
 *   - Reads the live `userPreferencesCollection` row (synced via
 *     UserSettingsDO). Effective value = per-arc override ?? global
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

type PerArcPrefs = Record<string, { autoAdvance?: boolean }>

interface UseArcAutoAdvanceResult {
  /** Effective "is auto-advance on" for this arc. */
  enabled: boolean
  /** True when a per-arc override exists (else falls back to the global default). */
  hasOverride: boolean
  /** Flip the per-arc override. Fire-and-forget; logs on network error. */
  toggle: () => Promise<void>
}

export function readArcPrefs(row: UserPreferencesRow | null | undefined): {
  perArc: PerArcPrefs
  defaultOn: boolean
} {
  if (!row) return { perArc: {}, defaultOn: false }
  const perArc = parseJsonField<PerArcPrefs>(row.chainsJson ?? null) ?? {}
  const defaultOn = row.defaultChainAutoAdvance === true
  return { perArc, defaultOn }
}

export function effectiveAutoAdvance(
  perArc: PerArcPrefs,
  defaultOn: boolean,
  issueNumber: number,
): boolean {
  const override = perArc[String(issueNumber)]?.autoAdvance
  if (typeof override === 'boolean') return override
  return defaultOn
}

export function useArcAutoAdvance(issueNumber: number): UseArcAutoAdvanceResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: prefsData } = useLiveQuery(userPreferencesCollection as any)

  const prefsRow = useMemo<UserPreferencesRow | null>(() => {
    if (!prefsData) return null
    const arr = prefsData as UserPreferencesRow[]
    return arr[0] ?? null
  }, [prefsData])

  const { perArc, defaultOn } = useMemo(() => readArcPrefs(prefsRow), [prefsRow])
  const enabled = effectiveAutoAdvance(perArc, defaultOn, issueNumber)
  const hasOverride = typeof perArc[String(issueNumber)]?.autoAdvance === 'boolean'

  const toggle = useCallback(async () => {
    const next: PerArcPrefs = {
      ...perArc,
      [String(issueNumber)]: { autoAdvance: !enabled },
    }
    try {
      const resp = await fetch(apiUrl('/api/preferences'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chains: next }),
      })
      if (!resp.ok) {
        console.warn('[useArcAutoAdvance] prefs PUT failed', resp.status)
      }
    } catch (err) {
      console.warn('[useArcAutoAdvance] prefs PUT threw', err)
    }
  }, [enabled, issueNumber, perArc])

  return { enabled, hasOverride, toggle }
}
