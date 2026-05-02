/**
 * GH#152 P1 (B3): per-arc membership REST surface.
 *
 * Mounted under `/api/arcs` from `createApiApp()` AFTER
 * `app.use('/api/*', authMiddleware)` so every handler reads
 * `c.get('userId')` / `c.get('role')` directly. The routes mounted
 * here are disjoint from those in `arcs.ts` (they live under
 * `/:id/members*` and `/invitations/*`), so both sub-apps can sit at
 * the same `/api/arcs` prefix without conflicting.
 *
 * Routes:
 *   - `GET    /api/arcs/:id/members`             — list members + pending invites
 *   - `POST   /api/arcs/:id/members`             — add by email or invite
 *   - `DELETE /api/arcs/:id/members/:userId`     — remove member
 *   - `POST   /api/arcs/invitations/:token/accept` — accept invite
 *
 * Owner-only mutations: gated by `checkArcAccess` returning
 * `role === 'owner'` (admin override included via that helper). Members
 * can only list. Sole-owner removal is rejected (409 last_owner) so an
 * arc never becomes orphaned.
 *
 * Email send: this codebase has no transactional-email helper today —
 * Better Auth's `emailAndPassword` is enabled without a `sendVerificationEmail`
 * hook. The invitation flow logs the acceptance URL to `console.info`
 * as the dev fallback; wiring a provider (Resend / Postmark / SES) is
 * tracked separately. The log call sits under `executionCtx.waitUntil`
 * so the response is never blocked by it.
 */

import { and, eq, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as schema from '~/db/schema'
import { arcInvitations, arcMembers, users } from '~/db/schema'
import { checkArcAccess } from '~/lib/arc-acl'
import { purgeArcMemberCache } from '~/lib/broadcast-arc-room'
import type { Env } from '~/lib/types'
import type { ApiAppEnv } from './context'

type Db = ReturnType<typeof drizzle<typeof schema>>

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function getDb(env: ApiAppEnv['Bindings']): Db {
  return drizzle(env.AUTH_DB, { schema })
}

/**
 * Resolve the current user's email. `authMiddleware` only stashes
 * `userId` and `role` on the context; we hit the `users` table for the
 * email so the accept-invite handler can compare against
 * `arc_invitations.email`. Single-row lookup by PK — cheap enough to
 * inline rather than thread through the middleware.
 */
async function getUserEmail(db: Db, userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return rows[0]?.email ?? null
}

function buildAcceptanceUrl(env: Env, token: string): string {
  const base = env.BETTER_AUTH_URL || 'http://localhost:43054'
  return `${base.replace(/\/+$/, '')}/invitations/${token}`
}

export function arcMembersRoutes() {
  const app = new Hono<ApiAppEnv>()

  // ── GET /:id/members ────────────────────────────────────────────────
  // Any arc member (or admin) can list. Returns members joined against
  // Better Auth `users` for name/email plus the unaccepted, non-expired
  // invitations.
  app.get('/:id/members', async (c) => {
    const userId = c.get('userId')
    const role = c.get('role')
    if (!userId) return c.json({ error: 'unauthenticated' }, 401)

    const arcId = c.req.param('id')
    const db = getDb(c.env)

    const access = await checkArcAccess(c.env as unknown as Env, db, arcId, { userId, role })
    if (!access.allowed) {
      return c.json({ error: 'forbidden' }, 403)
    }

    const memberRows = await db
      .select({
        userId: arcMembers.userId,
        email: users.email,
        name: users.name,
        role: arcMembers.role,
        addedAt: arcMembers.addedAt,
        addedBy: arcMembers.addedBy,
      })
      .from(arcMembers)
      .innerJoin(users, eq(users.id, arcMembers.userId))
      .where(eq(arcMembers.arcId, arcId))

    const nowIso = new Date().toISOString()
    const inviteRows = await db
      .select({
        token: arcInvitations.token,
        email: arcInvitations.email,
        role: arcInvitations.role,
        expiresAt: arcInvitations.expiresAt,
        invitedBy: arcInvitations.invitedBy,
      })
      .from(arcInvitations)
      .where(
        and(
          eq(arcInvitations.arcId, arcId),
          isNull(arcInvitations.acceptedAt),
          sql`${arcInvitations.expiresAt} > ${nowIso}`,
        ),
      )

    return c.json({ members: memberRows, invitations: inviteRows })
  })

  // ── POST /:id/members ───────────────────────────────────────────────
  // Owner-only. Body: `{email}`.
  //   - If a user with that email exists → insert arc_members row.
  //     Returns `{kind: 'added', member}`.
  //   - Else → insert arc_invitations row, log acceptance URL.
  //     Returns `{kind: 'invited', invitation}`.
  app.post('/:id/members', async (c) => {
    const callerId = c.get('userId')
    const callerRole = c.get('role')
    if (!callerId) return c.json({ error: 'unauthenticated' }, 401)

    const arcId = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null
    if (!body || typeof body.email !== 'string' || body.email.trim() === '') {
      return c.json({ error: 'email_required' }, 422)
    }
    const email = body.email.trim().toLowerCase()

    const db = getDb(c.env)

    const access = await checkArcAccess(c.env as unknown as Env, db, arcId, {
      userId: callerId,
      role: callerRole,
    })
    if (!access.allowed) return c.json({ error: 'forbidden' }, 403)
    if (access.role !== 'owner') return c.json({ error: 'not_owner' }, 403)

    // Case-insensitive lookup of Better Auth users by email. Better
    // Auth normalises emails to lowercase on insert, but be defensive
    // in case a row predates that contract.
    const existingUserRows = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1)
    const existingUser = existingUserRows[0]

    const nowIso = new Date().toISOString()

    if (existingUser) {
      // Duplicate guard so the composite-PK violation never fires.
      const dupe = await db
        .select({ userId: arcMembers.userId })
        .from(arcMembers)
        .where(and(eq(arcMembers.arcId, arcId), eq(arcMembers.userId, existingUser.id)))
        .limit(1)
      if (dupe[0]) return c.json({ error: 'already_member' }, 409)

      await db.insert(arcMembers).values({
        arcId,
        userId: existingUser.id,
        role: 'member',
        addedAt: nowIso,
        addedBy: callerId,
      })

      // GH#152 P1.3 WU-C: purge cached member list synchronously so
      // the next chat broadcast for this arc reads the new member.
      purgeArcMemberCache(arcId)

      return c.json({
        kind: 'added',
        member: {
          userId: existingUser.id,
          email: existingUser.email,
          name: existingUser.name,
          role: 'member',
          addedAt: nowIso,
        },
      })
    }

    // No user with that email — create an invitation.
    const token = crypto.randomUUID()
    const expiresAtIso = new Date(Date.now() + INVITE_TTL_MS).toISOString()

    await db.insert(arcInvitations).values({
      token,
      arcId,
      email,
      role: 'member',
      invitedBy: callerId,
      createdAt: nowIso,
      expiresAt: expiresAtIso,
    })

    const acceptanceUrl = buildAcceptanceUrl(c.env as unknown as Env, token)

    // No transactional-email provider wired today (see file header).
    // Log the payload so dev can complete the flow manually. Wrap in
    // waitUntil so the response is never blocked.
    c.executionCtx?.waitUntil(
      Promise.resolve().then(() => {
        console.info(
          `[arc-members] invitation queued arc=${arcId} email=${email} url=${acceptanceUrl}`,
        )
      }),
    )

    return c.json({
      kind: 'invited',
      invitation: {
        token,
        email,
        role: 'member',
        expiresAt: expiresAtIso,
      },
    })
  })

  // ── DELETE /:id/members/:userId ─────────────────────────────────────
  // Owner-only. Idempotent — missing row still returns 200. Sole-owner
  // self-removal is rejected (409 last_owner) so the arc never becomes
  // orphaned.
  app.delete('/:id/members/:userId', async (c) => {
    const callerId = c.get('userId')
    const callerRole = c.get('role')
    if (!callerId) return c.json({ error: 'unauthenticated' }, 401)

    const arcId = c.req.param('id')
    const targetUserId = c.req.param('userId')
    const db = getDb(c.env)

    const access = await checkArcAccess(c.env as unknown as Env, db, arcId, {
      userId: callerId,
      role: callerRole,
    })
    if (!access.allowed) return c.json({ error: 'forbidden' }, 403)
    if (access.role !== 'owner') return c.json({ error: 'not_owner' }, 403)

    // Last-owner guard. Look up the target's role; if they're the sole
    // owner (count of owners === 1 and target is one), reject.
    const targetRows = await db
      .select({ role: arcMembers.role })
      .from(arcMembers)
      .where(and(eq(arcMembers.arcId, arcId), eq(arcMembers.userId, targetUserId)))
      .limit(1)
    const target = targetRows[0]
    if (target?.role === 'owner') {
      const ownerCountRows = await db
        .select({ n: sql<number>`count(*)` })
        .from(arcMembers)
        .where(and(eq(arcMembers.arcId, arcId), eq(arcMembers.role, 'owner')))
      const ownerCount = Number(ownerCountRows[0]?.n ?? 0)
      if (ownerCount <= 1) {
        return c.json({ error: 'last_owner' }, 409)
      }
    }

    await db
      .delete(arcMembers)
      .where(and(eq(arcMembers.arcId, arcId), eq(arcMembers.userId, targetUserId)))

    // GH#152 P1.3 WU-C: purge cached member list synchronously so
    // the next chat broadcast no longer fans out to the removed user.
    purgeArcMemberCache(arcId)

    return c.json({ removed: true, userId: targetUserId })
  })

  // ── POST /invitations/:token/accept ─────────────────────────────────
  // Any logged-in user. Accepts iff token exists, is unaccepted, is not
  // expired, and the authed user's email matches the invitation email
  // (case-insensitive). Membership insert is idempotent (composite PK).
  app.post('/invitations/:token/accept', async (c) => {
    const userId = c.get('userId')
    if (!userId) return c.json({ error: 'unauthenticated' }, 401)

    const token = c.req.param('token')
    const db = getDb(c.env)

    const inviteRows = await db
      .select()
      .from(arcInvitations)
      .where(eq(arcInvitations.token, token))
      .limit(1)
    const invitation = inviteRows[0]
    if (!invitation) return c.json({ error: 'invitation_not_found' }, 404)

    if (invitation.acceptedAt) {
      return c.json({ error: 'invitation_already_accepted' }, 410)
    }

    const nowIso = new Date().toISOString()
    if (invitation.expiresAt <= nowIso) {
      return c.json({ error: 'invitation_expired' }, 410)
    }

    const callerEmail = await getUserEmail(db, userId)
    if (!callerEmail || callerEmail.toLowerCase() !== invitation.email.toLowerCase()) {
      return c.json({ error: 'email_mismatch' }, 403)
    }

    // D1 has no interactive transactions — use `db.batch()` for
    // atomicity (matches the pattern at `api/index.ts:1664`). The
    // `onConflictDoNothing` keeps membership insertion idempotent if
    // the user is already a member of the arc.
    const insertOp = db
      .insert(arcMembers)
      .values({
        arcId: invitation.arcId,
        userId,
        role: invitation.role === 'owner' ? 'owner' : 'member',
        addedAt: nowIso,
        addedBy: invitation.invitedBy,
      })
      .onConflictDoNothing()
    const updateOp = db
      .update(arcInvitations)
      .set({ acceptedAt: nowIso, acceptedBy: userId })
      .where(eq(arcInvitations.token, token))

    await db.batch([insertOp, updateOp])

    // GH#152 P1.3 WU-C: purge cached member list so subsequent chat
    // broadcasts include the just-accepted invitee.
    purgeArcMemberCache(invitation.arcId)

    return c.json({
      arcId: invitation.arcId,
      role: invitation.role === 'owner' ? 'owner' : 'member',
    })
  })

  return app
}
