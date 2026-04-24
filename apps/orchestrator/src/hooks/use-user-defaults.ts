import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '~/lib/platform'
import type { UserPreferences } from '~/lib/types'

const DEFAULTS: UserPreferences = {
  permissionMode: 'default',
  model: 'claude-opus-4-7',
  maxBudget: null,
  thinkingMode: 'adaptive',
  effort: 'xhigh',
}

// Bumped from `user-preferences` → `user-preferences-v2` so stale snake_case
// caches from the pre-camelCase schema don't mask the camelCase fields after
// this fix ships. Without the bump, the server's camelCase response would
// merge onto an old snake_case cache and the UI — which now reads camelCase —
// would see undefined/default values until the user manually touched every
// field.
const STORAGE_KEY = 'user-preferences-v2'

export function useUserDefaults() {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULTS)
  const [loading, setLoading] = useState(true)

  // Load from localStorage cache first, then fetch from server
  useEffect(() => {
    const cached = localStorage.getItem(STORAGE_KEY)
    if (cached) {
      try {
        setPreferences({ ...DEFAULTS, ...JSON.parse(cached) })
      } catch {
        // Ignore invalid cache
      }
    }

    // Fetch from server via registry DO
    fetch(apiUrl('/api/preferences'))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Object.keys(data).length > 0) {
          const merged = { ...DEFAULTS, ...data }
          setPreferences(merged)
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const updatePreferences = useCallback(
    async (patch: Partial<UserPreferences>) => {
      const updated = { ...preferences, ...patch }
      setPreferences(updated)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))

      await fetch(apiUrl('/api/preferences'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    },
    [preferences],
  )

  return { preferences, updatePreferences, loading }
}
