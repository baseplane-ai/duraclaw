import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { usePushSubscription } from '~/hooks/use-push-subscription'
import { apiUrl } from '~/lib/platform'

type WebRow = { user_agent: string | null; created_at: string }
type FcmRow = { platform: string; created_at: string }

type StatusResponse = {
  webSubscribed: boolean
  fcmSubscribed: boolean
  web: WebRow[]
  fcm: FcmRow[]
}

/**
 * Simplify a navigator user-agent string into a friendly label like
 * "Chrome on Linux". Falls back to the first 40 chars of the raw UA when
 * the regex doesn't catch a known browser/OS pair.
 */
function summarizeUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device'
  const browserMatch = ua.match(/(Firefox|Chrome|Safari|Edg|Opera)\/[\d.]+/)
  const osMatch = ua.match(/\((?:[^)]*?)(Windows|Mac OS X|Linux|Android|iPhone|iPad|iOS)/)
  const browser = browserMatch?.[1] === 'Edg' ? 'Edge' : browserMatch?.[1]
  const os = osMatch?.[1]
  if (browser && os) return `${browser} on ${os}`
  if (browser) return browser
  if (os) return os
  return ua.slice(0, 40)
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ts
    return d.toLocaleString()
  } catch {
    return ts
  }
}

export function PushSubscriptionStatus() {
  const { isSubscribed, subscribe, error } = usePushSubscription()
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch(apiUrl('/api/push/status'))
      if (!resp.ok) {
        console.error('[push] /api/push/status failed:', resp.status)
        return
      }
      const data = (await resp.json()) as StatusResponse
      setStatus(data)
    } catch (err) {
      console.error('[push] /api/push/status error:', err)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await refresh()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  const handleSubscribe = useCallback(async () => {
    setSubmitting(true)
    try {
      const ok = await subscribe()
      if (!ok) {
        toast.error(error ?? 'Subscribe failed')
        return
      }
      toast.success('Push notifications enabled')
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }, [subscribe, error, refresh])

  if (loading) {
    return <p className="py-4 text-center text-sm text-muted-foreground">Loading...</p>
  }

  const anySubscribed = (status?.webSubscribed ?? false) || (status?.fcmSubscribed ?? false)

  return (
    <div className="flex flex-col gap-3 py-2">
      <p className="text-sm font-medium">Push subscription</p>
      {anySubscribed ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Status: <span className="font-semibold">Active</span>
          </p>
          {status && status.web.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">Web subscriptions</p>
              <ul className="flex flex-col gap-1">
                {status.web.map((row) => (
                  <li
                    key={`${row.created_at}-${row.user_agent ?? 'unknown'}`}
                    className="text-xs text-muted-foreground"
                  >
                    {summarizeUserAgent(row.user_agent)} — {formatTimestamp(row.created_at)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {status && status.fcm.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">
                Mobile (FCM) subscriptions
              </p>
              <ul className="flex flex-col gap-1">
                {status.fcm.map((row) => (
                  <li
                    key={`${row.created_at}-${row.platform}`}
                    className="text-xs text-muted-foreground"
                  >
                    {row.platform} — {formatTimestamp(row.created_at)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!isSubscribed && (
            <p className="text-xs text-muted-foreground">
              This device is not in the list above. Resubscribe to receive notifications here.
            </p>
          )}
          <button
            type="button"
            onClick={handleSubscribe}
            disabled={submitting}
            className="w-fit rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {submitting ? 'Subscribing...' : 'Resubscribe this device'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Status: <span className="font-semibold">Inactive on this device</span>
          </p>
          <p className="text-xs text-muted-foreground">
            You will not receive push notifications until you subscribe.
          </p>
          <button
            type="button"
            onClick={handleSubscribe}
            disabled={submitting}
            className="w-fit rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? 'Subscribing...' : 'Subscribe'}
          </button>
        </div>
      )}
    </div>
  )
}
