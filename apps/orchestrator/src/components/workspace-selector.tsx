import { ChevronsUpDown, FolderGit2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '~/components/ui/sidebar'
import { apiUrl } from '~/lib/platform'
import type { ProjectInfo } from '~/lib/types'
import { useWorkspaceStore } from '~/stores/workspace'

interface Workspace {
  name: string
  projects: string[]
  repoOrigin: string | null
}

function extractWorkspaceName(repoOrigin: string): string {
  const cleaned = repoOrigin.replace(/\.git$/, '')
  const parts = cleaned.split(/[/:]/)
  const name = parts[parts.length - 1] || 'Unknown'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function groupProjectsIntoWorkspaces(projects: ProjectInfo[]): Workspace[] {
  const byOrigin = new Map<string | null, ProjectInfo[]>()

  for (const project of projects) {
    const key = project.repo_origin ?? null
    if (!byOrigin.has(key)) byOrigin.set(key, [])
    byOrigin.get(key)?.push(project)
  }

  const workspaces: Workspace[] = []

  for (const [origin, group] of byOrigin) {
    if (origin === null) {
      workspaces.push({
        name: 'Ungrouped',
        projects: group.map((p) => p.name),
        repoOrigin: null,
      })
    } else {
      workspaces.push({
        name: extractWorkspaceName(origin),
        projects: group.map((p) => p.name),
        repoOrigin: origin,
      })
    }
  }

  // Sort alphabetically, but put Ungrouped last
  workspaces.sort((a, b) => {
    if (a.repoOrigin === null) return 1
    if (b.repoOrigin === null) return -1
    return a.name.localeCompare(b.name)
  })

  return workspaces
}

export function WorkspaceSelector() {
  const { isMobile } = useSidebar()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const { activeWorkspace, setWorkspace } = useWorkspaceStore()

  useEffect(() => {
    fetch(apiUrl('/api/gateway/projects'))
      .then((r) => r.json() as Promise<ProjectInfo[] | { error: string }>)
      .then((data) => {
        if (Array.isArray(data)) {
          setWorkspaces(groupProjectsIntoWorkspaces(data))
        }
      })
      .catch(() => {
        // Gateway unavailable — leave workspaces empty
      })
  }, [])

  const active = workspaces.find((w) => w.name === activeWorkspace)
  const displayName = active ? active.name : 'All Workspaces'
  const projectCount = active
    ? active.projects.length
    : workspaces.reduce((n, w) => n + w.projects.length, 0)

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <FolderGit2 className="size-4" />
              </div>
              <div className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-semibold">{displayName}</span>
                <span className="truncate text-xs">
                  {projectCount} {projectCount === 1 ? 'project' : 'projects'}
                </span>
              </div>
              <ChevronsUpDown className="ms-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Workspaces
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setWorkspace(null, null)} className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-sm border">
                <FolderGit2 className="size-4 shrink-0" />
              </div>
              All
            </DropdownMenuItem>
            {workspaces.length > 0 && <DropdownMenuSeparator />}
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.name}
                onClick={() => setWorkspace(workspace.name, workspace.projects)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-sm border">
                  <FolderGit2 className="size-4 shrink-0" />
                </div>
                {workspace.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {workspace.projects.length}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
