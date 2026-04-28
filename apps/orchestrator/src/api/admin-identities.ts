/**
 * GH#119 P2: Admin CRUD for the `runner_identities` catalog.
 *
 * Mounted under `/api/admin/identities*` from `createApiApp()` (so the
 * top-level `app.use('/api/*', authMiddleware)` runs first and populates
 * `c.get('role')`). Every handler asserts admin role; non-admin → 403.
 *
 * Validation rules:
 *   - name: matches `[A-Za-z0-9_-]{1,64}`, must be unique. The name is
 *     also the leaf of the runner HOME path (`${IDENTITY_HOME_BASE}/${name}`)
 *     so it cannot contain `/`, `..`, or shell-meaningful characters.
 *   - status: 'available' | 'cooldown' | 'disabled' (PUT only)
 *
 * GH#129: `home_path` was dropped — the HOME is derived at use time
 * from `${IDENTITY_HOME_BASE}/${name}` so admins cannot drift the path
 * away from the identity name. POST tolerates a stale `home_path` field
 * for one release (silently ignored); PUT rejects `name` updates because
 * renaming would orphan the existing HOME directory on the VPS.
 *
 * Unlike `codex_models` (where `id == name`), this table uses a
 * generated UUID for `id` (Drizzle `$defaultFn`). The admin POST does
 * NOT receive an `id` from the client — it's generated server-side.
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as schema from '~/db/schema'
import { runnerIdentities } from '~/db/schema'
import type { ApiAppEnv } from './context'

function getDb(env: ApiAppEnv['Bindings']) {
  return drizzle(env.AUTH_DB, { schema })
}

const VALID_STATUSES = new Set(['available', 'cooldown', 'disabled'])

/** GH#129: identity names are also HOME-path leaves — restrict to a
 *  filesystem-safe shape. Length cap mirrors the worst-case Linux
 *  filename limit minus headroom for the `${base}/` prefix. */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

interface CreateBody {
  name?: unknown
  /** @deprecated GH#129 — silently ignored; HOME is derived from name. */
  home_path?: unknown
}

interface UpdateBody {
  /** GH#129 — rejected with 400 if present (name changes orphan HOME). */
  name?: unknown
  /** @deprecated GH#129 — silently ignored. */
  home_path?: unknown
  status?: unknown
}

export function adminIdentitiesRoutes() {
  const app = new Hono<ApiAppEnv>()

  // Every endpoint below requires admin.
  app.use('*', async (c, next) => {
    if (c.get('role') !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }
    await next()
  })

  // GET /api/admin/identities — list all rows ordered by name.
  app.get('/', async (c) => {
    const db = getDb(c.env)
    const rows = await db.select().from(runnerIdentities).orderBy(runnerIdentities.name)
    return c.json({ identities: rows })
  })

  // POST /api/admin/identities — create.
  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as CreateBody | null
    if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json({ error: 'missing_required_field', field: 'name' }, 400)
    }
    const name = body.name.trim()
    // GH#129: name is also the HOME path leaf — enforce a filesystem-safe
    // shape so the derived path can't escape `${IDENTITY_HOME_BASE}/`.
    if (!NAME_RE.test(name)) {
      return c.json({ error: 'invalid_name', detail: 'must match [A-Za-z0-9_-]{1,64}' }, 400)
    }
    // GH#129: `body.home_path` is silently ignored for one release so
    // older admin clients don't break. Drop the field entirely after.

    const db = getDb(c.env)

    // Defensive uniqueness check (the UNIQUE index would also reject this).
    const existing = await db
      .select({ id: runnerIdentities.id })
      .from(runnerIdentities)
      .where(eq(runnerIdentities.name, name))
      .limit(1)
    if (existing.length > 0) {
      return c.json({ error: 'duplicate_identity_name', name }, 409)
    }

    const now = new Date().toISOString()
    let insertedId: string
    try {
      const [row] = await db
        .insert(runnerIdentities)
        .values({
          name,
          status: 'available',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: runnerIdentities.id })
      insertedId = row.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // SQLite raises a UNIQUE-constraint error on race past the pre-check.
      // Map to the same 409 the pre-check would have produced.
      if (/UNIQUE|constraint/i.test(msg)) {
        return c.json({ error: 'duplicate_identity_name', name }, 409)
      }
      throw err
    }

    const inserted = await db
      .select()
      .from(runnerIdentities)
      .where(eq(runnerIdentities.id, insertedId))
      .limit(1)
    return c.json(inserted[0], 201)
  })

  // PUT /api/admin/identities/:id — update.
  app.put('/:id', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as UpdateBody | null
    if (!body) {
      return c.json({ error: 'missing_required_field', field: 'body' }, 400)
    }

    const db = getDb(c.env)
    const existing = await db
      .select()
      .from(runnerIdentities)
      .where(eq(runnerIdentities.id, id))
      .limit(1)
    if (existing.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    // GH#129: `name` is the HOME path leaf — renaming would orphan the
    // physical HOME directory on the VPS. Reject any update that tries
    // to change it. To rename an identity, delete + re-create after the
    // operator has moved the underlying HOME directory.
    if (body.name !== undefined) {
      return c.json({ error: 'name_immutable' }, 400)
    }
    // `body.home_path` is silently ignored — the column was dropped in
    // migration 0030.

    const updates: Partial<typeof runnerIdentities.$inferInsert> = {}
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status)) {
        return c.json({ error: 'invalid_status' }, 400)
      }
      updates.status = body.status
    }

    updates.updatedAt = new Date().toISOString()

    try {
      await db.update(runnerIdentities).set(updates).where(eq(runnerIdentities.id, id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE|constraint/i.test(msg)) {
        return c.json({ error: 'duplicate_identity_name' }, 409)
      }
      throw err
    }

    const after = await db
      .select()
      .from(runnerIdentities)
      .where(eq(runnerIdentities.id, id))
      .limit(1)
    return c.json(after[0])
  })

  // DELETE /api/admin/identities/:id — delete.
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const db = getDb(c.env)
    const existing = await db
      .select({ id: runnerIdentities.id })
      .from(runnerIdentities)
      .where(eq(runnerIdentities.id, id))
      .limit(1)
    if (existing.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }
    await db.delete(runnerIdentities).where(eq(runnerIdentities.id, id))
    return c.body(null, 204)
  })

  return app
}
