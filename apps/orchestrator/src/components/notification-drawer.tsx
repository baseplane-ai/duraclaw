import { AlertTriangle, CheckCircle, Settings, Shield } from 'lucide-react'
import { useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { cn } from '~/lib/utils'
import type { AppNotification } from '~/stores/notifications'
import { useNotificationStore } from '~/stores/notifications'
import { NotificationPreferences } from './notification-preferences'

interface NotificationDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function getIcon(type: AppNotification['type']) {
  switch (type) {
    case 'gate':
      return <Shield className="h-4 w-4 text-yellow-500" />
    case 'completed':
      return <CheckCircle className="h-4 w-4 text-green-500" />
    case 'error':
      return <AlertTriangle className="h-4 w-4 text-red-500" />
  }
}

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function NotificationDrawer({ open, onOpenChange }: NotificationDrawerProps) {
  const { notifications, markRead, markAllRead, clearAll } = useNotificationStore()
  const [showPrefs, setShowPrefs] = useState(false)

  const handleClick = (n: AppNotification) => {
    markRead(n.id)
    onOpenChange(false)
    window.location.href = n.url
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[380px] sm:w-[420px]">
        <SheetHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription className="sr-only">
            Recent notifications and alerts from your sessions
          </SheetDescription>
          <button
            type="button"
            onClick={() => setShowPrefs((p) => !p)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="Notification settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        </SheetHeader>

        {showPrefs ? (
          <NotificationPreferences />
        ) : (
          <div className="flex flex-col gap-1">
            {notifications.length > 0 && (
              <div className="flex justify-between px-1 pb-2">
                <button
                  type="button"
                  onClick={markAllRead}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Mark all as read
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear all
                </button>
              </div>
            )}

            {notifications.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No notifications yet</p>
            ) : (
              <div className="flex max-h-[calc(100vh-120px)] flex-col gap-0.5 overflow-y-auto">
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleClick(n)}
                    className={cn(
                      'flex items-start gap-3 rounded-md p-3 text-left transition-colors hover:bg-accent',
                      !n.read && 'bg-accent/50',
                    )}
                  >
                    <div className="mt-0.5 shrink-0">{getIcon(n.type)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{n.sessionName}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {relativeTime(n.timestamp)}
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{n.body}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
