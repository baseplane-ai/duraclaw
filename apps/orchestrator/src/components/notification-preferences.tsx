import { useCallback, useEffect, useState } from 'react'
import { Label } from '~/components/ui/label'
import { Switch } from '~/components/ui/switch'
import { apiUrl } from '~/lib/platform'

type Preferences = Record<string, string>

const PREF_KEYS = [
  { key: 'push.enabled', label: 'Push notifications' },
  { key: 'push.blocked', label: 'Gate blocked' },
  { key: 'push.completed', label: 'Session completed' },
  { key: 'push.error', label: 'Session error' },
  { key: 'push.sound', label: 'Notification sound' },
] as const

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Preferences>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(apiUrl('/api/user/preferences'))
      .then((r) => r.json())
      .then((data) => setPrefs(data as Preferences))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const togglePref = useCallback(async (key: string, value: boolean) => {
    const strValue = value ? 'true' : 'false'
    setPrefs((prev) => ({ ...prev, [key]: strValue }))

    try {
      await fetch(apiUrl('/api/user/preferences'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: strValue }),
      })
    } catch {
      setPrefs((prev) => {
        const reverted = { ...prev }
        delete reverted[key]
        return reverted
      })
    }
  }, [])

  if (loading) {
    return <p className="py-4 text-center text-sm text-muted-foreground">Loading...</p>
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm font-medium">Notification Preferences</p>
      {PREF_KEYS.map(({ key, label }) => {
        const isEnabled = prefs[key] !== 'false'
        return (
          <div key={key} className="flex items-center justify-between">
            <Label htmlFor={key} className="text-sm">
              {label}
            </Label>
            <Switch
              id={key}
              checked={isEnabled}
              onCheckedChange={(checked) => togglePref(key, !!checked)}
            />
          </div>
        )
      })}
    </div>
  )
}
