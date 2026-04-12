import { useState } from 'react'
import { toast } from 'sonner'
import { usePushSubscription } from '~/hooks/use-push-subscription'

export function PushOptInBanner() {
  const { permission, isSubscribed, subscribe } = usePushSubscription()
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('push-prompt-dismissed') === 'true'
  })

  // Hide if: already subscribed, denied, unsupported, or dismissed
  if (dismissed || isSubscribed || permission === 'denied' || permission === 'unsupported') {
    return null
  }

  const handleEnable = async () => {
    const success = await subscribe()
    if (success) {
      toast.success('Notifications enabled')
      localStorage.setItem('push-prompt-dismissed', 'true')
      setDismissed(true)
    } else if (Notification.permission === 'denied') {
      toast.error('Notifications blocked — enable in browser settings')
      localStorage.setItem('push-prompt-dismissed', 'true')
      setDismissed(true)
    }
  }

  const handleDismiss = () => {
    localStorage.setItem('push-prompt-dismissed', 'true')
    setDismissed(true)
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/50 p-4">
      <p className="text-sm text-muted-foreground">
        Enable push notifications to know when sessions need input.
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={handleEnable}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Enable
        </button>
      </div>
    </div>
  )
}
