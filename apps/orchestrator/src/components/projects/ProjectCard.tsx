/**
 * ProjectCard (GH#122 P4 / B-UI-2 + B-UI-4)
 *
 * One card per project on the `/projects` index. Renders:
 *   - Project name + branch + visibility badge.
 *   - Ownership status block (`Owner: <id slice>` | `Unowned [Claim]` |
 *     `Unowned — ask an admin`).
 *   - `[Open Sessions]` link → `/?project=<name>`.
 *   - `[Open Docs]` link → `/projects/$projectId/docs` (disabled when
 *     `project.projectId` is null — see OR-4).
 *   - `[Claim]` button (admin + unowned only).
 *   - `[Transfer ownership]` button (owner OR admin on owned project).
 *
 * Optimistic UI relies on the server's broadcastSyncedDelta to refresh
 * the projectsCollection — no manual refetch.
 */

import type { ProjectInfo } from '@duraclaw/shared-types'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { VisibilityBadge } from '~/components/visibility-badge'
import { apiUrl } from '~/lib/platform'
import { TransferOwnershipDialog } from './TransferOwnershipDialog'

export interface ProjectCardProps {
  project: ProjectInfo
  currentUserId: string | null
  currentUserRole: string
}

export function ProjectCard({ project, currentUserId, currentUserRole }: ProjectCardProps) {
  const isAdmin = currentUserRole === 'admin'
  const isOwner = currentUserId !== null && project.ownerId === currentUserId
  const isUnowned = !project.ownerId
  const [claiming, setClaiming] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)

  const onClaim = async () => {
    if (!project.projectId) return
    setClaiming(true)
    try {
      const resp = await fetch(apiUrl(`/api/projects/${project.projectId}/claim`), {
        method: 'POST',
        credentials: 'include',
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        toast.error(`Claim failed (${resp.status}) ${body}`)
      } else {
        toast.success('Project claimed')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setClaiming(false)
    }
  }

  const visibility: 'public' | 'private' = project.visibility === 'private' ? 'private' : 'public'

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="font-mono text-base">{project.name}</CardTitle>
        <CardDescription className="flex items-center gap-2">
          <span className="truncate">{project.branch}</span>
          <VisibilityBadge visibility={visibility} />
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">
          {isUnowned ? (
            isAdmin ? (
              <span>Unowned</span>
            ) : (
              <span>Unowned — ask an admin</span>
            )
          ) : (
            <span>Owner: {project.ownerId?.slice(0, 8) ?? 'unknown'}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/" search={{ project: project.name } as never}>
              Open Sessions
            </Link>
          </Button>
          {project.projectId ? (
            <Button asChild size="sm" variant="outline">
              <Link to="/projects/$projectId/docs" params={{ projectId: project.projectId }}>
                Open Docs
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled
              title="Project not yet synced — try again in a moment"
            >
              Open Docs
            </Button>
          )}
          {isUnowned && isAdmin && (
            <Button size="sm" onClick={onClaim} disabled={claiming || !project.projectId}>
              {claiming ? 'Claiming…' : 'Claim'}
            </Button>
          )}
          {!isUnowned && (isOwner || isAdmin) && project.projectId && (
            <Button size="sm" variant="outline" onClick={() => setTransferOpen(true)}>
              Transfer ownership
            </Button>
          )}
        </div>
      </CardContent>
      {transferOpen && project.projectId && (
        <TransferOwnershipDialog
          projectId={project.projectId}
          projectName={project.name}
          currentOwnerId={project.ownerId ?? null}
          currentUserRole={currentUserRole}
          onClose={() => setTransferOpen(false)}
        />
      )}
    </Card>
  )
}
