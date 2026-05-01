// GH#116 P1: vitest fixture that seeds pre-migration agent_sessions
// rows, runs migration 0034_arcs_first_class.sql, and asserts the
// post-migration shape matches the spec.
//
// Test infra rationale: this repo has no live D1 fixture (no
// @cloudflare/vitest-pool-workers, no miniflare boot). The pre-existing
// `apps/orchestrator/src/lib/migrations.test.ts` only does string-shape
// validation, which is too weak for a structural reshape this size. The
// closest in-process SQLite available in the workspace is `sql.js`
// (transitive of `@journeyapps/wa-sqlite` via TanStack DB), which sits
// in the pnpm store but is not directly listed as a dep here. We import
// it via its deep .pnpm path — workable because (a) sql.js is pure
// JS/WASM with no native build, (b) the path is deterministic post-
// install, and (c) the deferred alternative (adding better-sqlite3 as a
// dev dep) was out of scope for this wave per the implementer brief.
//
// The migration is read off disk and split on `--> statement-breakpoint`
// markers (matching wrangler's own runner). Each test gets a fresh
// in-memory DB seeded with just enough schema (users + agent_sessions +
// worktrees) to satisfy the migration's FKs and UPDATE joins.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

// sql.js lives in the pnpm store; resolve via deep path. Cast the
// dynamic import to `unknown` so the file typechecks without a sql.js
// type stub (the package isn't in our package.json).
// biome-ignore lint/suspicious/noExplicitAny: deep-path import has no types
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

const migrationsDir = resolve(__dirname, '../../migrations')

function readMigration(filename: string): string {
  return readFileSync(resolve(migrationsDir, filename), 'utf-8')
}

/**
 * Split a wrangler-style migration on `--> statement-breakpoint`
 * markers and return the non-empty statements.
 *
 * The marker only counts when it's its own line — wrangler's runner
 * splits on the line-anchored breakpoint, and migration headers
 * sometimes mention the marker text inside an `--` comment (e.g.
 * "separated by `--> statement-breakpoint` markers"). A literal
 * substring split would misfire on those references.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/^--> statement-breakpoint\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Apply a migration's statements to the DB serially. Each statement is
 * executed via `db.run` — same semantics wrangler uses (DDL
 * auto-commits, no wrapping BEGIN/COMMIT).
 */
function applyMigration(db: SqlJsDatabase, migrationSql: string): void {
  for (const stmt of splitStatements(migrationSql)) {
    db.run(stmt)
  }
}

/**
 * Seed the minimum pre-migration schema needed for 0034 to apply
 * cleanly: users (FK target), worktrees (FK target — already present
 * post-#115), agent_sessions (the table being reshaped). Schema mirrors
 * the post-#115 state at the moment migration 0034 runs.
 */
function seedPreMigrationSchema(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
  `)
  db.run(`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      branch TEXT,
      status TEXT NOT NULL DEFAULT 'held',
      reservedBy TEXT,
      released_at INTEGER,
      createdAt INTEGER NOT NULL,
      lastTouchedAt INTEGER NOT NULL,
      ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
  `)
  // Pre-0034 agent_sessions shape: kata_mode/kata_issue/kata_phase
  // present, worktreeId already added by #115's migration 0031, no
  // arc_id / mode / parent_session_id yet.
  db.run(`
    CREATE TABLE agent_sessions (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project text NOT NULL,
      status text NOT NULL DEFAULT 'running',
      model text,
      runner_session_id text,
      identity_name text,
      capabilities_json text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      last_activity text,
      num_turns integer,
      message_seq integer NOT NULL DEFAULT -1,
      prompt text,
      summary text,
      title text,
      title_source text,
      tag text,
      origin text DEFAULT 'duraclaw',
      agent text DEFAULT 'claude',
      archived integer NOT NULL DEFAULT 0,
      duration_ms integer,
      total_cost_usd real,
      kata_mode text,
      kata_issue integer,
      kata_phase text,
      kata_state_json text,
      context_usage_json text,
      worktreeId text REFERENCES worktrees(id),
      visibility text NOT NULL DEFAULT 'public',
      error text,
      error_code text
    );
  `)
}

function insertUser(db: SqlJsDatabase, userId: string): void {
  db.run(
    `INSERT INTO users(id, name, email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, userId, `${userId}@example.com`, 1700000000, 1700000000],
  )
}

function insertWorktree(db: SqlJsDatabase, id: string, ownerId: string, path: string): void {
  db.run(
    `INSERT INTO worktrees(id, path, branch, status, reservedBy, createdAt, lastTouchedAt, ownerId)
     VALUES (?, ?, NULL, 'held', NULL, ?, ?, ?)`,
    [id, path, 1700000000000, 1700000000000, ownerId],
  )
}

interface SeedSession {
  id: string
  userId: string
  kataIssue: number | null
  kataMode: string | null
  prompt?: string
  worktreeId?: string | null
  project?: string
}

function insertAgentSession(db: SqlJsDatabase, s: SeedSession): void {
  db.run(
    `INSERT INTO agent_sessions(
       id, user_id, project, status, created_at, updated_at,
       last_activity, kata_mode, kata_issue, kata_phase, prompt, worktreeId
     ) VALUES (?, ?, ?, 'idle', ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      s.id,
      s.userId,
      s.project ?? 'duraclaw',
      '2026-04-29T00:00:00Z',
      '2026-04-29T00:00:00Z',
      '2026-04-29T00:00:00Z',
      s.kataMode,
      s.kataIssue,
      s.prompt ?? null,
      s.worktreeId ?? null,
    ],
  )
}

/** Run a SELECT and return `{columns, values}` for the first result set. */
function query(db: SqlJsDatabase, sql: string): { columns: string[]; values: unknown[][] } {
  const rs = db.exec(sql)
  if (rs.length === 0) return { columns: [], values: [] }
  return rs[0]
}

/** Helper: run a SELECT and return rows as an array of plain objects. */
function rows(db: SqlJsDatabase, sql: string): Array<Record<string, unknown>> {
  const r = query(db, sql)
  return r.values.map((v) => {
    const obj: Record<string, unknown> = {}
    r.columns.forEach((col, i) => {
      obj[col] = v[i]
    })
    return obj
  })
}

describe('migration 0034 — arcs first class', () => {
  const migrationSql = readMigration('0034_arcs_first_class.sql')
  let db: SqlJsDatabase

  beforeEach(async () => {
    const SqlJs = await getSQL()
    db = new SqlJs.Database()
    seedPreMigrationSchema(db)
  })

  it('chain pattern: two sessions sharing kataIssue=42 backfill into one arc', () => {
    insertUser(db, 'user-1')
    insertAgentSession(db, {
      id: 'sess-a',
      userId: 'user-1',
      kataIssue: 42,
      kataMode: 'research',
    })
    insertAgentSession(db, {
      id: 'sess-b',
      userId: 'user-1',
      kataIssue: 42,
      kataMode: 'planning',
    })

    applyMigration(db, migrationSql)

    // Exactly one arc for (userId='user-1', external_ref.id=42).
    const arcCount = rows(
      db,
      `SELECT count(*) AS c FROM arcs
       WHERE user_id='user-1'
         AND json_extract(external_ref, '$.id') = 42`,
    )
    expect(arcCount[0].c).toBe(1)

    // Both sessions point at the same arc.
    const sessRows = rows(
      db,
      `SELECT id, arc_id, mode FROM agent_sessions
       WHERE id IN ('sess-a','sess-b') ORDER BY id`,
    )
    expect(sessRows).toHaveLength(2)
    expect(sessRows[0].arc_id).toBe(sessRows[1].arc_id)
    expect(sessRows[0].arc_id).not.toBeNull()

    // mode column carries kata_mode values.
    const byId = Object.fromEntries(sessRows.map((r) => [r.id, r.mode]))
    expect(byId['sess-a']).toBe('research')
    expect(byId['sess-b']).toBe('planning')

    // The arc itself: status=open (kata-linked), title built from
    // 'Issue #42', external_ref carries provider+id+url.
    const arc = rows(
      db,
      `SELECT id, title, status, external_ref
       FROM arcs
       WHERE json_extract(external_ref, '$.id') = 42`,
    )[0]
    expect(arc.status).toBe('open')
    expect(arc.title).toBe('Issue #42')
    const ref = JSON.parse(arc.external_ref as string)
    expect(ref.provider).toBe('github')
    expect(ref.id).toBe(42)
    expect(ref.url).toContain('issues/42')
  })

  it('orphan: session with kataIssue=null gets its own implicit arc', () => {
    insertUser(db, 'user-2')
    insertAgentSession(db, {
      id: 'sess-orphan',
      userId: 'user-2',
      kataIssue: null,
      kataMode: null,
      prompt: 'Just exploring something',
    })

    applyMigration(db, migrationSql)

    // Exactly one arc for user-2 with NULL external_ref.
    const arcCount = rows(
      db,
      `SELECT count(*) AS c FROM arcs
       WHERE user_id='user-2' AND external_ref IS NULL`,
    )
    expect(arcCount[0].c).toBe(1)

    // Implicit arc id matches the migration's 'arc_orphan_' || id pattern.
    const arc = rows(
      db,
      `SELECT id, title, status FROM arcs
       WHERE user_id='user-2' AND external_ref IS NULL`,
    )[0]
    expect(arc.id).toBe('arc_orphan_sess-orphan')
    expect(arc.status).toBe('draft')
    // Title is the first 50 chars of prompt — for our short prompt
    // that's the whole prompt.
    expect(arc.title).toBe('Just exploring something')

    // Session points at the implicit arc.
    const sessRow = rows(db, `SELECT arc_id FROM agent_sessions WHERE id='sess-orphan'`)[0]
    expect(sessRow.arc_id).toBe('arc_orphan_sess-orphan')
  })

  it('drops kata columns: post-migration agent_sessions has no kata_mode/kata_issue/kata_phase', () => {
    insertUser(db, 'user-x')
    insertAgentSession(db, {
      id: 'sess-x',
      userId: 'user-x',
      kataIssue: 7,
      kataMode: 'research',
    })

    applyMigration(db, migrationSql)

    // PRAGMA shows the new columns and lacks the old ones.
    const cols = rows(db, `PRAGMA table_info(agent_sessions)`).map((r) => r.name as string)
    expect(cols).toContain('arc_id')
    expect(cols).toContain('mode')
    expect(cols).toContain('parent_session_id')
    expect(cols).not.toContain('kata_mode')
    expect(cols).not.toContain('kata_issue')
    expect(cols).not.toContain('kata_phase')

    // Querying a dropped column throws.
    expect(() => db.exec('SELECT kata_mode FROM agent_sessions')).toThrow()
    expect(() => db.exec('SELECT kata_issue FROM agent_sessions')).toThrow()
    expect(() => db.exec('SELECT kata_phase FROM agent_sessions')).toThrow()
  })

  it('arc-worktree-backfilled: arcs.worktree_id picks up from agent_sessions.worktreeId', () => {
    insertUser(db, 'user-3')
    insertWorktree(db, 'wt-99', 'user-3', '/data/projects/test-repo')
    insertAgentSession(db, {
      id: 'sess-99',
      userId: 'user-3',
      kataIssue: 99,
      kataMode: 'research',
      worktreeId: 'wt-99',
    })

    applyMigration(db, migrationSql)

    // The arc for issue 99 carries the seed session's worktreeId.
    const arc = rows(
      db,
      `SELECT worktree_id FROM arcs
       WHERE json_extract(external_ref, '$.id') = 99`,
    )[0]
    expect(arc.worktree_id).toBe('wt-99')
  })
})
