import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '~/components/ui/sidebar'
import { useLayout } from '~/context/layout-provider'
import { useSession } from '~/lib/auth-client'
import { AppTitle } from './app-title'
import { adminNavGroup, sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'
import { NavSessions } from './nav-sessions'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === 'admin'

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        {sidebarData.navGroups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
        <NavSessions />
        {isAdmin && <NavGroup {...adminNavGroup} />}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={sidebarData.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
