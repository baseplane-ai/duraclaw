/**
 * GH#122 B-AUTH-1: requireProjectMember middleware factory.
 *
 * Must be chained AFTER `projectMetadataAuth` so `c.get('bearerAuth')`
 * is populated. Bearer-authed (DOCS_RUNNER_SECRET) requests bypass the
 * `project_members` lookup entirely (B-AUTH-6). Admin-role users also
 * bypass (admin override per B-AUTH-2). Otherwise looks up the caller's
 * row in `project_members` and compares `role` against `minRole` using
 * a strict numeric rank (viewer < editor < owner).
 *
 * Returns 403 with `reason='not-a-project-member'` for callers with no
 * row, or `reason='insufficient-role'` when the row exists but the
 * role is below `minRole`.
 */
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { createMiddleware } from 'hono/factory'
import { projectMembers } from '~/db/schema'
import type { ApiAppEnv } from '../context'

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 } as const
type Role = keyof typeof ROLE_RANK

const PROJECT_ID_RE = /^[0-9a-f]{16}$/

export function requireProjectMember(minRole: Role) {
  return createMiddleware<ApiAppEnv>(async (c, next) => {
    // B-AUTH-6: DOCS_RUNNER_SECRET bearer bypasses project membership.
    if (c.get('bearerAuth')) {
      await next()
      return
    }

    const userId = c.get('userId')
    if (!userId) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    // B-AUTH-2: admin override.
    if (c.get('role') === 'admin') {
      await next()
      return
    }

    const projectId = c.req.param('projectId')
    if (!projectId || !PROJECT_ID_RE.test(projectId)) {
      return c.json({ error: 'bad_request' }, 400)
    }

    const db = drizzle(c.env.AUTH_DB)
    const rows = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1)

    if (rows.length === 0) {
      return c.json(
        {
          error: 'forbidden',
          reason: 'not-a-project-member',
          requiredRole: minRole,
          actualRole: null,
        },
        403,
      )
    }

    const role = rows[0].role as Role
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
      return c.json(
        {
          error: 'forbidden',
          reason: 'insufficient-role',
          requiredRole: minRole,
          actualRole: role,
        },
        403,
      )
    }

    await next()
  })
}
