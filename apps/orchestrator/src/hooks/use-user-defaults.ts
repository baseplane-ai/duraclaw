import { useCallback, useEffect, useState } from 'react'
import type { UserPreferences } from '~/lib/types'

const DEFAULTS: UserPreferences = {
  permission_mode: 'default',
  model: 'claude-opus-4-7',
  max_budget: null,
  thinking_mode: 'adaptive',
  effort: 'high',
}

export function useUserDefaults() {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULTS)
  const [loading, setLoading] = useState(true)

  // Load from localStorage cache first, then fetch from server
  useEffect(() => {
    const cached = localStorage.getItem('user-preferences')
    if (cached) {
      try {
        setPreferences({ ...DEFAULTS, ...JSON.parse(cached) })
      } catch {
        // Ignore invalid cache
      }
    }

    // Fetch from server via registry DO
    fetch('/api/preferences')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Object.keys(data).length > 0) {
          const merged = { ...DEFAULTS, ...data }
          setPreferences(merged)
          localStorage.setItem('user-preferences', JSON.stringify(merged))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const updatePreferences = useCallback(
    async (patch: Partial<UserPreferences>) => {
      const updated = { ...preferences, ...patch }
      setPreferences(updated)
      localStorage.setItem('user-preferences', JSON.stringify(updated))

      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    },
    [preferences],
  )

  return { preferences, updatePreferences, loading }
}
