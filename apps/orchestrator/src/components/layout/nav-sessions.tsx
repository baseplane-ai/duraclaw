/**
 * NavSessions — Session list rendered inside the AppSidebar.
 * Replaces the standalone SessionSidebar panel.
 */

import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { PlusIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '~/components/ui/sidebar'
import { getPreviewText, StatusDot } from '~/features/agent-orch/session-utils'
import {
  type SessionRecord,
  useAgentOrchSessions,
} from '~/features/agent-orch/use-agent-orch-sessions'
import { useTabStore } from '~/stores/tabs'

function getDisplayName(session: SessionRecord): string {
  return session.title || getPreviewText(session) || session.id.slice(0, 8)
}

export function NavSessions() {
  const { sessions } = useAgentOrchSessions()
  const { setOpenMobile } = useSidebar()
  const location = useLocation()
  const navigate = useNavigate()
  const addTab = useTabStore((s) => s.addTab)
  const [showAll, setShowAll] = useState(false)

  // Show non-archived sessions, sorted by updated_at desc
  const visible = sessions.filter((s) => !s.archived)
  const displayed = showAll ? visible : visible.slice(0, 10)
  const hasMore = visible.length > 10

  const handleSelect = useCallback(
    (session: SessionRecord) => {
      const title = getDisplayName(session)
      addTab(session.id, title)
      setOpenMobile(false)
      navigate({ to: '/', search: { session: session.id } })
    },
    [addTab, setOpenMobile, navigate],
  )

  // Determine active session from URL
  const searchParams = new URLSearchParams(location.searchStr)
  const activeSessionId = location.pathname.startsWith('/session/')
    ? location.pathname.split('/session/')[1]
    : searchParams.get('session')

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Sessions</SidebarGroupLabel>
      <SidebarGroupAction asChild>
        <Link to="/" aria-label="New session" onClick={() => setOpenMobile(false)}>
          <PlusIcon className="size-4" />
        </Link>
      </SidebarGroupAction>
      <SidebarMenu>
        {displayed.map((session) => {
          const status = session.status || 'idle'
          const numTurns = session.num_turns ?? 0
          const isActive = activeSessionId === session.id

          return (
            <SidebarMenuItem key={session.id}>
              <SidebarMenuButton
                isActive={isActive}
                tooltip={getDisplayName(session)}
                onClick={() => handleSelect(session)}
              >
                <StatusDot status={status} numTurns={numTurns} />
                <span className="truncate">{getDisplayName(session)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
        {visible.length === 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <span className="text-muted-foreground">No sessions yet</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {hasMore && !showAll && (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setShowAll(true)}>
              <span className="text-muted-foreground">Show {visible.length - 10} more...</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}
