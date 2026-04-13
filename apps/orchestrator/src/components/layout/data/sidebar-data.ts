import { Clock, LayoutDashboard, MessagesSquare, Settings, Users } from 'lucide-react'
import type { NavGroup, SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: 'User',
    email: '',
    avatar: '',
  },
  navGroups: [
    {
      title: 'General',
      items: [
        {
          title: 'Dashboard',
          url: '/',
          icon: LayoutDashboard,
        },
        {
          title: 'Sessions',
          url: '/',
          icon: MessagesSquare,
        },
        {
          title: 'History',
          url: '/history',
          icon: Clock,
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
  ],
}
