/**
 * GH#119 P2: Admin CRUD for the `runner_identities` catalog.
 *
 * Mounted under `/api/admin/identities*` from `createApiApp()` (so the
 * top-level `app.use('/api/*', authMiddleware)` runs first and populates
 * `c.get('role')`). Every handler asserts admin role; non-admin → 403.
 *
 * Validation rules (per spec B4):
 *   - name: non-empty string, must be unique
 *   - home_path: non-empty string
 *   - status: 'available' | 'cooldown' | 'disabled' (PUT only)
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

interface CreateBody {
  name?: unknown
  home_path?: unknown
}

interface UpdateBody {
  name?: unknown
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
    if (typeof body.home_path !== 'string' || body.home_path.trim() === '') {
      return c.json({ error: 'missing_required_field', field: 'home_path' }, 400)
    }

    const name = body.name.trim()
    const homePath = body.home_path.trim()
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
          homePath,
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

    const updates: Partial<typeof runnerIdentities.$inferInsert> = {}
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return c.json({ error: 'missing_required_field', field: 'name' }, 400)
      }
      updates.name = body.name.trim()
    }
    if (body.home_path !== undefined) {
      if (typeof body.home_path !== 'string' || body.home_path.trim() === '') {
        return c.json({ error: 'missing_required_field', field: 'home_path' }, 400)
      }
      updates.homePath = body.home_path.trim()
    }
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
        return c.json({ error: 'duplicate_identity_name', name: updates.name }, 409)
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
