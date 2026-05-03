/**
 * GH#152 P1.5 WU-E — coverage for SessionDO migration v24 (mentions
 * column on the comments table).
 *
 * Mirrors the structure of `session-do-migrations-v23.test.ts`:
 *   1. FakeSql adapter checks the migration metadata + statement shape.
 *   2. Real-SQLite (sql.js) checks introspect the post-migration schema
 *      via PRAGMA + round-trip an INSERT NULL / INSERT JSON / SELECT to
 *      confirm the column accepts the expected payload shapes.
 *
 * v24 is a tiny additive ALTER on top of v23's CREATE TABLE comments,
 * so we apply v23 then v24 and assert the column appears (TEXT, nullable)
 * with no other table-shape drift.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { type MigrationSql, runMigrations } from '~/lib/do-migrations'
import { SESSION_DO_MIGRATIONS } from './session-do-migrations'

// ── 1. Statement-level checks via the FakeSql adapter ─────────────────

class FakeSql implements MigrationSql {
  statements: Array<{ query: string; bindings: unknown[] }> = []
  appliedVersions = new Set<number>()

  exec(query: string, ...bindings: unknown[]) {
    this.statements.push({ query, bindings })
    if (query.includes('SELECT MAX(version)')) {
      const version = this.appliedVersions.size > 0 ? Math.max(...this.appliedVersions) : null
      return { toArray: () => [{ version }] }
    }
    if (query.includes('INSERT INTO _schema_version')) {
      this.appliedVersions.add(Number(bindings[0]))
      return { toArray: () => [] }
    }
    return { toArray: () => [] }
  }
}

describe('SESSION_DO_MIGRATIONS — v24 statement-level checks', () => {
  it('declares a v24 migration that adds the `mentions` column to comments', () => {
    const v24 = SESSION_DO_MIGRATIONS.find((m) => m.version === 24)
    expect(v24).toBeDefined()
    expect(v24!.description.toLowerCase()).toContain('mentions')
  })

  it('issues ALTER TABLE comments ADD COLUMN mentions TEXT', () => {
    const sql = new FakeSql()
    runMigrations(sql, SESSION_DO_MIGRATIONS)
    expect(sql.appliedVersions.has(24)).toBe(true)

    const altered = sql.statements.some((s) =>
      /ALTER TABLE\s+comments\s+ADD COLUMN\s+mentions\s+TEXT/i.test(s.query),
    )
    expect(altered).toBe(true)
  })

  it('is idempotent — re-running with v24 already applied is a no-op', () => {
    const sql = new FakeSql()
    sql.appliedVersions.add(24)
    runMigrations(sql, SESSION_DO_MIGRATIONS)

    const mentionsStmts = sql.statements.filter((s) =>
      /ALTER TABLE comments ADD COLUMN mentions/i.test(s.query),
    )
    expect(mentionsStmts).toHaveLength(0)
  })
})

// ── 2. Real-SQLite checks via sql.js (deep-path import) ───────────────

const SQL_JS_PATH =
  '/data/projects/duraclaw-dev5/node_modules/.pnpm/sql.js@1.14.1/node_modules/sql.js/dist/sql-wasm.js'

interface SqlJsDatabase {
  run: (sql: string, params?: unknown[]) => void
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>
  close: () => void
}

interface SqlJsStatic {
  Database: new () => SqlJsDatabase
}

let SQL: SqlJsStatic | null = null

async function getSQL(): Promise<SqlJsStatic> {
  if (SQL) return SQL
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import of unlisted dep
  const mod: any = await import(/* @vite-ignore */ SQL_JS_PATH)
  const initSqlJs = mod.default ?? mod
  SQL = (await initSqlJs()) as SqlJsStatic
  return SQL
}

function rows(db: SqlJsDatabase, sql: string): Array<Record<string, unknown>> {
  const rs = db.exec(sql)
  if (rs.length === 0) return []
  const r = rs[0]
  return r.values.map((v) => {
    const obj: Record<string, unknown> = {}
    r.columns.forEach((col, i) => {
      obj[col] = v[i]
    })
    return obj
  })
}

/**
 * Apply a single migration's `up` body against a real sqlite db. The
 * MigrationSql contract is variadic (query, ...bindings); sql.js's
 * `run` expects an array. Adapt between the two.
 */
function apply(db: SqlJsDatabase, version: number): void {
  const m = SESSION_DO_MIGRATIONS.find((x) => x.version === version)!
  m.up({
    exec(query: string, ...bindings: unknown[]) {
      db.run(query, bindings)
      return { toArray: () => [] }
    },
  })
}

describe('SESSION_DO_MIGRATIONS — v24 real-SQLite shape', () => {
  let db: SqlJsDatabase

  beforeEach(async () => {
    const SqlJs = await getSQL()
    db = new SqlJs.Database()
    apply(db, 23) // CREATE TABLE comments (...)
    apply(db, 24) // ALTER TABLE comments ADD COLUMN mentions TEXT
  })

  it('adds the mentions column with type TEXT and nullable=true', () => {
    const cols = rows(db, `PRAGMA table_info(comments)`)
    const byName = Object.fromEntries(cols.map((r) => [r.name as string, r]))
    expect(byName.mentions).toBeDefined()
    expect(byName.mentions).toMatchObject({ type: 'TEXT', notnull: 0 })
    // Default value is NULL (PRAGMA reports `dflt_value: null`).
    expect(byName.mentions.dflt_value).toBeNull()
  })

  it('the rest of the comments columns are unchanged after v24', () => {
    const cols = rows(db, `PRAGMA table_info(comments)`).map((r) => r.name as string)
    // v23 columns + the new `mentions` column.
    expect(cols.sort()).toEqual(
      [
        'arc_id',
        'author_user_id',
        'body',
        'created_at',
        'deleted_at',
        'deleted_by',
        'edited_at',
        'id',
        'mentions',
        'message_id',
        'modified_at',
        'parent_comment_id',
        'session_id',
      ].sort(),
    )
  })

  it('round-trips INSERT NULL + INSERT JSON-string + SELECT against the new column', () => {
    db.run(
      `INSERT INTO comments (id, arc_id, session_id, message_id, parent_comment_id,
                              author_user_id, body, mentions, created_at, modified_at,
                              edited_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        'cmt-no-mentions',
        'arc-1',
        'sess-1',
        'msg-1',
        null,
        'user-A',
        'no @ here',
        null,
        1000,
        1000,
      ],
    )
    db.run(
      `INSERT INTO comments (id, arc_id, session_id, message_id, parent_comment_id,
                              author_user_id, body, mentions, created_at, modified_at,
                              edited_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        'cmt-with-mentions',
        'arc-1',
        'sess-1',
        'msg-1',
        null,
        'user-A',
        'hi @b @c',
        JSON.stringify(['user-b', 'user-c']),
        2000,
        2000,
      ],
    )

    const noMentionsRow = rows(db, `SELECT mentions FROM comments WHERE id = 'cmt-no-mentions'`)[0]
    expect(noMentionsRow.mentions).toBeNull()

    const withMentionsRow = rows(
      db,
      `SELECT mentions FROM comments WHERE id = 'cmt-with-mentions'`,
    )[0]
    expect(typeof withMentionsRow.mentions).toBe('string')
    expect(JSON.parse(withMentionsRow.mentions as string)).toEqual(['user-b', 'user-c'])
  })
})
