/**
 * NavSessions — Session list rendered inside the AppSidebar, grouped by project.
 */

import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronRight, FolderIcon, PlusIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '~/components/ui/collapsible'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
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

  // Show non-archived sessions, grouped by project
  const visible = sessions.filter((s) => !s.archived)
  const groups = new Map<string, SessionRecord[]>()
  for (const session of visible) {
    const key = session.project || 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)?.push(session)
  }

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
        {Array.from(groups.entries()).map(([project, projectSessions]) => (
          <ProjectGroup
            key={project}
            project={project}
            sessions={projectSessions}
            activeSessionId={activeSessionId}
            onSelect={handleSelect}
          />
        ))}
        {visible.length === 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <span className="text-muted-foreground">No sessions yet</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}

function ProjectGroup({
  project,
  sessions,
  activeSessionId,
  onSelect,
}: {
  project: string
  sessions: SessionRecord[]
  activeSessionId: string | null
  onSelect: (session: SessionRecord) => void
}) {
  const hasActive = sessions.some((s) => s.id === activeSessionId)
  const [maxVisible, setMaxVisible] = useState(5)
  const displayed = sessions.slice(0, maxVisible)
  const hasMore = sessions.length > maxVisible

  return (
    <Collapsible
      asChild
      defaultOpen={hasActive || sessions.length <= 5}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={project}>
            <FolderIcon className="size-4" />
            <span>{project}</span>
            <span className="ml-auto text-xs text-muted-foreground">{sessions.length}</span>
            <ChevronRight className="ml-1 size-3 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {displayed.map((session) => {
              const status = session.status || 'idle'
              const numTurns = session.num_turns ?? 0
              const isActive = activeSessionId === session.id

              return (
                <SidebarMenuSubItem key={session.id}>
                  <SidebarMenuSubButton isActive={isActive} onClick={() => onSelect(session)}>
                    <StatusDot status={status} numTurns={numTurns} />
                    <span className="truncate">{getDisplayName(session)}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
            {hasMore && (
              <SidebarMenuSubItem>
                <SidebarMenuSubButton onClick={() => setMaxVisible((v) => v + 10)}>
                  <span className="text-muted-foreground">
                    {sessions.length - maxVisible} more...
                  </span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
