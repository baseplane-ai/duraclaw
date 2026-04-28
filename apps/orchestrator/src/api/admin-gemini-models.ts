/**
 * GH#110 P2: Admin CRUD for the `gemini_models` catalog.
 *
 * Mounted under `/api/admin/gemini-models*` from `createApiApp()` (so the
 * top-level `app.use('/api/*', authMiddleware)` runs first and populates
 * `c.get('role')`). Every handler asserts admin role; non-admin → 403.
 *
 * Validation rules (per spec B4):
 *   - name: non-empty string, must be unique
 *   - context_window: positive integer
 *   - max_output_tokens: optional, integer if present
 *   - enabled: boolean (PUT only)
 *
 * The `id` column equals `name` on insert (the unique index on `name` is
 * a defensive double-check). PUT/DELETE address rows by `:id`.
 */

import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as schema from '~/db/schema'
import { geminiModels } from '~/db/schema'
import type { ApiAppEnv } from './context'

function getDb(env: ApiAppEnv['Bindings']) {
  return drizzle(env.AUTH_DB, { schema })
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0
}

interface CreateBody {
  name?: unknown
  context_window?: unknown
  max_output_tokens?: unknown
}

interface UpdateBody {
  name?: unknown
  context_window?: unknown
  max_output_tokens?: unknown
  enabled?: unknown
}

export function adminGeminiModelsRoutes() {
  const app = new Hono<ApiAppEnv>()

  // Every endpoint below requires admin.
  app.use('*', async (c, next) => {
    if (c.get('role') !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }
    await next()
  })

  // GET /api/admin/gemini-models — list all rows ordered by name.
  app.get('/', async (c) => {
    const db = getDb(c.env)
    const rows = await db.select().from(geminiModels).orderBy(geminiModels.name)
    return c.json({ models: rows })
  })

  // POST /api/admin/gemini-models — create.
  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as CreateBody | null
    if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json({ error: 'missing_required_field', field: 'name' }, 400)
    }
    if (body.context_window === undefined || body.context_window === null) {
      return c.json({ error: 'missing_required_field', field: 'context_window' }, 400)
    }
    if (!isPositiveInt(body.context_window)) {
      return c.json({ error: 'invalid_context_window' }, 400)
    }
    if (body.max_output_tokens !== undefined && !isPositiveInt(body.max_output_tokens)) {
      return c.json({ error: 'invalid_max_output_tokens' }, 400)
    }

    const name = body.name.trim()
    const db = getDb(c.env)

    // Defensive uniqueness check (the UNIQUE index would also reject this).
    const existing = await db
      .select({ id: geminiModels.id })
      .from(geminiModels)
      .where(eq(geminiModels.name, name))
      .limit(1)
    if (existing.length > 0) {
      return c.json({ error: 'duplicate_model_name', name }, 409)
    }

    const now = new Date().toISOString()
    try {
      await db.insert(geminiModels).values({
        id: name,
        name,
        contextWindow: body.context_window,
        maxOutputTokens: isPositiveInt(body.max_output_tokens) ? body.max_output_tokens : null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // SQLite raises a UNIQUE-constraint error on race-conditions past the
      // pre-check. Map to the same 409 the pre-check would have produced.
      if (/UNIQUE|constraint/i.test(msg)) {
        return c.json({ error: 'duplicate_model_name', name }, 409)
      }
      throw err
    }

    const inserted = await db.select().from(geminiModels).where(eq(geminiModels.id, name)).limit(1)
    return c.json(inserted[0], 201)
  })

  // PUT /api/admin/gemini-models/:id — update.
  app.put('/:id', async (c) => {
    const id = c.req.param('id')
    const body = (await c.req.json().catch(() => null)) as UpdateBody | null
    if (!body) {
      return c.json({ error: 'missing_required_field', field: 'body' }, 400)
    }

    const db = getDb(c.env)
    const existing = await db.select().from(geminiModels).where(eq(geminiModels.id, id)).limit(1)
    if (existing.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    const updates: Partial<typeof geminiModels.$inferInsert> = {}
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return c.json({ error: 'missing_required_field', field: 'name' }, 400)
      }
      const newName = body.name.trim()
      // Seeding invariant: id == name. Renaming a model would either
      // strand the row's id pointing at the old name (broken invariant)
      // or require an atomic id-rewrite (cascading concerns elsewhere).
      // Simplest correct policy: disallow renames. Callers that want a
      // rename can DELETE + POST.
      if (newName !== existing[0].name) {
        return c.json({ error: 'name_immutable' }, 400)
      }
      updates.name = newName
    }
    if (body.context_window !== undefined) {
      if (!isPositiveInt(body.context_window)) {
        return c.json({ error: 'invalid_context_window' }, 400)
      }
      updates.contextWindow = body.context_window
    }
    if (body.max_output_tokens !== undefined) {
      if (body.max_output_tokens === null) {
        updates.maxOutputTokens = null
      } else if (!isPositiveInt(body.max_output_tokens)) {
        return c.json({ error: 'invalid_max_output_tokens' }, 400)
      } else {
        updates.maxOutputTokens = body.max_output_tokens
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'invalid_enabled' }, 400)
      }
      updates.enabled = body.enabled
    }

    updates.updatedAt = new Date().toISOString()

    await db.update(geminiModels).set(updates).where(eq(geminiModels.id, id))

    const after = await db.select().from(geminiModels).where(eq(geminiModels.id, id)).limit(1)
    return c.json(after[0])
  })

  // DELETE /api/admin/gemini-models/:id — delete.
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const db = getDb(c.env)
    const existing = await db
      .select({ id: geminiModels.id })
      .from(geminiModels)
      .where(eq(geminiModels.id, id))
      .limit(1)
    if (existing.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }
    await db.delete(geminiModels).where(eq(geminiModels.id, id))
    return c.body(null, 204)
  })

  return app
}
