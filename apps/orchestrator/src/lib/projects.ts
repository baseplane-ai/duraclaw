/**
 * GH#122 B-UI-7: name → projectId resolver.
 *
 * Server-side helper used by session-card linkage code that has only
 * `session.project` (the human-readable name) and needs the 16-hex
 * `projects.projectId` for `/api/projects/:projectId/*` routes.
 *
 * Returns `null` when the name is unknown, or when the matching
 * `projects` row has `projectId === null` (gateway hasn't synced
 * `repo_origin` yet, or this is a local-only clone with no origin URL).
 */

import { desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import { projectMetadata, projects as projectsTable } from '~/db/schema'
import type { ProjectInfo } from '~/lib/types'

type Db = ReturnType<typeof drizzle>

export async function getProjectIdByName(db: Db, name: string): Promise<string | null> {
  const rows = await db
    .select({ projectId: projectsTable.projectId })
    .from(projectsTable)
    .where(eq(projectsTable.name, name))
    .orderBy(desc(projectsTable.updatedAt))
    .limit(1)
  return rows[0]?.projectId ?? null
}

/**
 * GH#122 B-HELPER-2: build a `ProjectInfo` payload for claim/transfer
 * broadcast deltas. LEFT JOIN's projects + projectMetadata so callers
 * can fan out a single delta to every userPresence-active user after
 * an ownership mutation. Throws if the projectId doesn't match any
 * `projects` row — both endpoints validate the row exists before
 * calling this helper, so a throw here is a programmer error.
 *
 * Shape mirrors the sync handler's broadcast payload (B-SYNC-2): the
 * D1-known fields (name, path, visibility, ownerId, projectId) are
 * authoritative; the gateway-only fields (branch, dirty, ahead/behind,
 * pr) are stubbed to safe defaults — clients merge into their existing
 * row via TanStack DB upsert semantics, so the stale gateway-only
 * fields stay intact on the receiving end.
 */
export async function projectInfoFromMeta(db: Db, projectId: string): Promise<ProjectInfo> {
  const rows = await db
    .select({
      name: projectsTable.name,
      rootPath: projectsTable.rootPath,
      visibility: projectsTable.visibility,
      ownerId: projectMetadata.ownerId,
    })
    .from(projectsTable)
    .leftJoin(projectMetadata, eq(projectsTable.projectId, projectMetadata.projectId))
    .where(eq(projectsTable.projectId, projectId))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new Error(`projectInfoFromMeta: no projects row for projectId=${projectId}`)
  }
  return {
    name: row.name,
    path: row.rootPath,
    branch: 'unknown',
    dirty: false,
    active_session: null,
    repo_origin: null,
    ahead: 0,
    behind: 0,
    pr: null,
    visibility: (row.visibility === 'private' ? 'private' : 'public') as 'public' | 'private',
    ownerId: row.ownerId ?? null,
    projectId,
  }
}
