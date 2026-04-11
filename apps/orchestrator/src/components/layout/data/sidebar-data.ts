import { Clock, Command, LayoutDashboard, MessagesSquare, Settings } from 'lucide-react'
import type { SidebarData } from '../types'

export const sidebarData: SidebarData = {
  user: {
    name: 'User',
    email: '',
    avatar: '',
  },
  teams: [
    {
      name: 'Duraclaw',
      logo: Command,
      plan: 'Orchestrator',
    },
  ],
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
