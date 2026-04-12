import { Bell } from 'lucide-react'
import { useNotificationStore } from '~/stores/notifications'

interface NotificationBellProps {
  onClick?: () => void
}

export function NotificationBell({ onClick }: NotificationBellProps) {
  const unreadCount = useNotificationStore((s) => s.notifications.filter((n) => !n.read).length)

  return (
    <button
      type="button"
      onClick={onClick}
      className="relative inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
    >
      <Bell className="h-5 w-5" />
      {unreadCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  )
}
