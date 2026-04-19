import { Bug, LayoutGrid, MessagesSquare, Settings, Users } from 'lucide-react'
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
      title: 'Debug: session collection',
      url: '/debug/session-collection',
      icon: Bug,
    },
  ],
}
