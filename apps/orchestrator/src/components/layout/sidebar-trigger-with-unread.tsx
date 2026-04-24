import { SidebarTrigger } from '~/components/ui/sidebar'
import { cn } from '~/lib/utils'
import { useNotificationStore } from '~/stores/notifications'

type Props = React.ComponentProps<typeof SidebarTrigger>

/**
 * `SidebarTrigger` with a small red dot overlaid when unread notifications
 * are present. Lets us bury the notification bell inside the sidebar
 * (opens the `NotificationDrawer` from a nav item) while keeping new-
 * notification discoverability on the hamburger itself.
 */
export function SidebarTriggerWithUnread({ className, ...props }: Props) {
  const hasUnread = useNotificationStore((s) => s.notifications.some((n) => !n.read))

  return (
    <span className="relative inline-flex">
      <SidebarTrigger className={className} {...props} />
      {hasUnread && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute right-0.5 top-0.5',
            'h-2 w-2 rounded-full bg-destructive',
            'ring-2 ring-background',
          )}
        />
      )}
    </span>
  )
}
