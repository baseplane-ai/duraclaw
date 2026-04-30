/**
 * /projects (GH#122 P4 / B-UI-1)
 *
 * Visibility-filtered list of project cards.
 *
 * - Admin: every project.
 * - Non-admin: public projects + private projects they own (via
 *   `ownerId === userId`).
 *
 * Backed by `projectsCollection` (synced collection, includes the new
 * `ownerId` / `projectId` fields populated by P2's atomic dual-write).
 */

import type { ProjectInfo } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { createFileRoute } from '@tanstack/react-router'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { ProjectCard } from '~/components/projects/ProjectCard'
import { Skeleton } from '~/components/ui/skeleton'
import { projectsCollection } from '~/db/projects-collection'
import { useSession as useAuthSession } from '~/lib/auth-client'

export const Route = createFileRoute('/_authenticated/projects')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const { data: authSession } = useAuthSession()
  const userId = (authSession as { user?: { id?: string } } | null)?.user?.id ?? null
  const role = (authSession as { user?: { role?: string } } | null)?.user?.role ?? 'user'
  const isAdmin = role === 'admin'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectRows, isLoading } = useLiveQuery(projectsCollection as any)
  const projects = (projectRows ?? []) as ProjectInfo[]

  // B-UI-1 visibility filter — admin sees all; non-admin sees public +
  // owned-private.
  const visible = projects
    .filter((p) => {
      if (isAdmin) return true
      if (p.visibility !== 'private') return true
      return p.ownerId === userId
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  if (isLoading) {
    return (
      <>
        <Header fixed>
          <h1 className="text-lg font-semibold">Projects</h1>
        </Header>
        <Main>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable placeholder list
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        </Main>
      </>
    )
  }

  if (visible.length === 0) {
    return (
      <>
        <Header fixed>
          <h1 className="text-lg font-semibold">Projects</h1>
        </Header>
        <Main>
          <p className="text-sm text-muted-foreground">
            No projects discovered yet — the gateway syncs every 30s.
          </p>
        </Main>
      </>
    )
  }

  return (
    <>
      <Header fixed>
        <h1 className="text-lg font-semibold">Projects</h1>
      </Header>
      <Main>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((p) => (
            <ProjectCard key={p.name} project={p} currentUserId={userId} currentUserRole={role} />
          ))}
        </div>
      </Main>
    </>
  )
}
