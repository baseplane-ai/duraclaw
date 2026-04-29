import { FolderTree, LayoutGrid, MessagesSquare, Rocket, Settings, Users } from 'lucide-react'
import type { NavGroup, SidebarData } from '../types'

export const sidebarData: SidebarData = {
  navGroups: [
    {
      title: 'General',
      items: [
        {
          title: 'Sessions',
          url: '/',
          icon: MessagesSquare,
        },
        {
          title: 'Projects',
          url: '/projects',
          icon: FolderTree,
        },
        {
          title: 'Board',
          url: '/board',
          icon: LayoutGrid,
        },
        {
          title: 'Settings',
          url: '/settings',
          icon: Settings,
        },
      ],
    },
  ],
}

export const adminNavGroup: NavGroup = {
  title: 'Admin',
  items: [
    {
      title: 'Users',
      url: '/admin/users',
      icon: Users,
    },
    {
      title: 'Deploys',
      url: '/deploys',
      icon: Rocket,
    },
  ],
}
