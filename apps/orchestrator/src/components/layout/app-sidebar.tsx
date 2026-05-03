import { Link } from '@tanstack/react-router'
import { Bell, Inbox as InboxIcon } from 'lucide-react'
import { useState } from 'react'
import { NotificationDrawer } from '~/components/notification-drawer'
import { Badge } from '~/components/ui/badge'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '~/components/ui/sidebar'
import { useLayout } from '~/context/layout-provider'
import { useUnreadMentionsCount } from '~/features/arc-orch/use-arc-mentions'
import { useSession } from '~/lib/auth-client'
import { useNotificationStore } from '~/stores/notifications'
import { AppTitle } from './app-title'
import { adminNavGroup, sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavSessions } from './nav-sessions'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'admin'
  const user = session?.user ?? null
  const [drawerOpen, setDrawerOpen] = useState(false)
  const unreadCount = useNotificationStore((s) => s.notifications.filter((n) => !n.read).length)
  // GH#152 P1.5 WU-D: live @-mention badge driven by the arcMentions
  // synced collection (see features/arc-orch/use-arc-mentions.ts).
  const unreadMentions = useUnreadMentionsCount()

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
                onClick={() => setDrawerOpen(true)}
              >
                <Bell />
                <span>Notifications</span>
                {unreadCount > 0 && (
                  <Badge className="ms-auto rounded-full px-1 py-0 text-xs">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </Badge>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip={`Inbox${unreadMentions > 0 ? ` (${unreadMentions} unread)` : ''}`}
              >
                <Link to="/inbox" data-testid="nav-inbox-link">
                  <InboxIcon />
                  <span>Inbox</span>
                  {unreadMentions > 0 && (
                    <Badge
                      className="ms-auto rounded-full px-1 py-0 text-xs"
                      data-testid="nav-inbox-badge"
                    >
                      {unreadMentions > 99 ? '99+' : unreadMentions}
                    </Badge>
                  )}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {sidebarData.navGroups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
        <NavSessions />
        {isAdmin && <NavGroup {...adminNavGroup} />}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
      <NotificationDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
    </Sidebar>
  )
}
