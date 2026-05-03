/**
 * GH#152 P1.2 WU-E — coverage for migration v23 (comments table).
 *
 * Two complementary check layers:
 *   1. The lightweight `FakeSql` from the existing
 *      `session-do-migrations.test.ts` confirms the migration issues
 *      the right CREATE TABLE / CREATE INDEX statements without a real
 *      sqlite engine.
 *   2. A real in-memory SQLite (sql.js) actually runs the v23 SQL so we
 *      can introspect via `PRAGMA table_info(comments)` /
 *      `PRAGMA index_list(comments)` and round-trip an INSERT + SELECT.
 *      sql.js is reused here from `apps/orchestrator/src/db/migration-test.test.ts`'s
 *      deep-path import (no new dep required).
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

describe('SESSION_DO_MIGRATIONS — v23 statement-level checks', () => {
  it('declares a v23 migration that creates the comments table', () => {
    const v23 = SESSION_DO_MIGRATIONS.find((m) => m.version === 23)
    expect(v23).toBeDefined()
    expect(v23!.description.toLowerCase()).toContain('comments')
  })

  it('issues CREATE TABLE comments + the three required indexes', () => {
    const sql = new FakeSql()
    runMigrations(sql, SESSION_DO_MIGRATIONS)
    expect(sql.appliedVersions.has(23)).toBe(true)

    const tableCreated = sql.statements.some((s) =>
      /CREATE TABLE\s+IF NOT EXISTS\s+comments/i.test(s.query),
    )
    expect(tableCreated).toBe(true)

    const sessionMsgIdx = sql.statements.some((s) =>
      /idx_comments_session_message_created[\s\S]*\(session_id,\s*message_id,\s*created_at\)/i.test(
        s.query,
      ),
    )
    const parentIdx = sql.statements.some((s) =>
      /idx_comments_parent[\s\S]*\(parent_comment_id\)[\s\S]*WHERE\s+parent_comment_id\s+IS\s+NOT\s+NULL/i.test(
        s.query,
      ),
    )
    const arcIdx = sql.statements.some((s) =>
      /idx_comments_arc_modified_id[\s\S]*\(arc_id,\s*modified_at,\s*id\)/i.test(s.query),
    )
    expect(sessionMsgIdx).toBe(true)
    expect(parentIdx).toBe(true)
    expect(arcIdx).toBe(true)
  })

  it('is idempotent — re-running with v23 already applied is a no-op', () => {
    const sql = new FakeSql()
    sql.appliedVersions.add(23)
    runMigrations(sql, SESSION_DO_MIGRATIONS)
    // Filter scoped to v23's specific shapes (CREATE TABLE comments + the
    // three CREATE INDEX statements). Later migrations may legitimately
    // touch the `comments` table (e.g. v24's `ALTER TABLE comments ADD
    // COLUMN mentions`) — those should still emit, just not v23's.
    const v23Stmts = sql.statements.filter((s) =>
      /CREATE\s+TABLE\s+comments\b|CREATE\s+INDEX\s+\w*comments?_/i.test(s.query),
    )
    expect(v23Stmts).toHaveLength(0)
  })
})

// ── 2. Real-SQLite checks via sql.js (deep-path import) ───────────────
//
// Mirrors the import strategy in `apps/orchestrator/src/db/migration-test.test.ts`:
// pure-JS sql.js is in the pnpm store as a transitive dep, no native build,
// path is deterministic post-install. Lets us actually introspect schema
// + indexes via PRAGMA — which the FakeSql layer cannot.
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
 * Apply the v23 migration body against a real sqlite db. The DO
 * migration runner expects a `MigrationSql` shim whose `exec` is
 * variadic (query, ...bindings); sql.js's `run(query, params[])` takes
 * an array. Adapt between the two so the migration runs verbatim.
 */
function applyV23(db: SqlJsDatabase): void {
  const v23 = SESSION_DO_MIGRATIONS.find((m) => m.version === 23)!
  v23.up({
    exec(query: string, ...bindings: unknown[]) {
      db.run(query, bindings)
      return { toArray: () => [] }
    },
  })
}

describe('SESSION_DO_MIGRATIONS — v23 real-SQLite shape', () => {
  let db: SqlJsDatabase

  beforeEach(async () => {
    const SqlJs = await getSQL()
    db = new SqlJs.Database()
    applyV23(db)
  })

  it('creates the comments table with the expected columns + nullability', () => {
    const cols = rows(db, `PRAGMA table_info(comments)`)
    const byName = Object.fromEntries(cols.map((r) => [r.name as string, r]))

    // Spot-check every column declared in the migration. `notnull` is
    // 1 for NOT NULL, 0 otherwise; `pk` is the primary-key ordinal
    // (>0 for PK columns).
    expect(byName.id).toMatchObject({ type: 'TEXT', pk: 1 })
    expect(byName.arc_id).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.session_id).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.message_id).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.parent_comment_id).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(byName.author_user_id).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.body).toMatchObject({ type: 'TEXT', notnull: 1 })
    expect(byName.created_at).toMatchObject({ type: 'INTEGER', notnull: 1 })
    expect(byName.modified_at).toMatchObject({ type: 'INTEGER', notnull: 1 })
    expect(byName.edited_at).toMatchObject({ type: 'INTEGER', notnull: 0 })
    expect(byName.deleted_at).toMatchObject({ type: 'INTEGER', notnull: 0 })
    expect(byName.deleted_by).toMatchObject({ type: 'TEXT', notnull: 0 })

    // No stray columns slipped in.
    const colNames = cols.map((c) => c.name as string).sort()
    expect(colNames).toEqual(
      [
        'arc_id',
        'author_user_id',
        'body',
        'created_at',
        'deleted_at',
        'deleted_by',
        'edited_at',
        'id',
        'message_id',
        'modified_at',
        'parent_comment_id',
        'session_id',
      ].sort(),
    )
  })

  it('creates the three required indexes with the documented columns', () => {
    const indexes = rows(db, `PRAGMA index_list('comments')`)
    const byName = Object.fromEntries(indexes.map((r) => [r.name as string, r]))

    expect(byName).toHaveProperty('idx_comments_session_message_created')
    expect(byName).toHaveProperty('idx_comments_parent')
    expect(byName).toHaveProperty('idx_comments_arc_modified_id')

    const sessionMsgCols = rows(db, `PRAGMA index_info('idx_comments_session_message_created')`)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((r) => r.name as string)
    expect(sessionMsgCols).toEqual(['session_id', 'message_id', 'created_at'])

    const parentCols = rows(db, `PRAGMA index_info('idx_comments_parent')`)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((r) => r.name as string)
    expect(parentCols).toEqual(['parent_comment_id'])

    const arcCols = rows(db, `PRAGMA index_info('idx_comments_arc_modified_id')`)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((r) => r.name as string)
    expect(arcCols).toEqual(['arc_id', 'modified_at', 'id'])
  })

  it('round-trips an INSERT + SELECT against the comments table', () => {
    db.run(
      `INSERT INTO comments (id, arc_id, session_id, message_id, parent_comment_id,
                              author_user_id, body, created_at, modified_at,
                              edited_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ['cmt-1', 'arc-1', 'sess-1', 'msg-1', null, 'user-A', 'hi there', 1000, 1000],
    )
    const out = rows(db, `SELECT * FROM comments WHERE id = 'cmt-1'`)[0]
    expect(out).toMatchObject({
      id: 'cmt-1',
      arc_id: 'arc-1',
      session_id: 'sess-1',
      message_id: 'msg-1',
      parent_comment_id: null,
      author_user_id: 'user-A',
      body: 'hi there',
      created_at: 1000,
      modified_at: 1000,
      edited_at: null,
      deleted_at: null,
      deleted_by: null,
    })
  })
})
