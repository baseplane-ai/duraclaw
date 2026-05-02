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

// ── GH#152 P1 — migration 0036 (expand) + 0038 (contract) ─────────────
//
// 0036 adds arc_members, arc_invitations, arcs.visibility, and
// backfills visibility from agent_sessions.visibility ('public' wins
// because MAX() on text puts 'public' before 'private' lexicographically
// — actually wait: 'public' > 'private' lexically because 'p' < 'p',
// then 'r' < 'u', so 'public' > 'private'. MAX() picks the larger →
// 'public'. The migration relies on this ordering).
//
// 0038 drops agent_sessions.visibility — but only once 0036's backfill
// is verified complete. We test the backfill-complete pre-condition
// (`SELECT COUNT(*) FROM arcs WHERE visibility IS NULL` returns 0)
// without actually running the destructive DROP.

describe('migration 0036 — arc-collab ACL (per-arc visibility + members)', () => {
  const migration0034 = readMigration('0034_arcs_first_class.sql')
  const migration0036 = readMigration('0036_arc_collab_acl.sql')
  let db: SqlJsDatabase

  beforeEach(async () => {
    const SqlJs = await getSQL()
    db = new SqlJs.Database()
    seedPreMigrationSchema(db)
  })

  it("backfills arcs.visibility='public' from any public agent_sessions row in that arc", () => {
    insertUser(db, 'user-1')
    // Two sessions same kataIssue → one arc; one session has
    // visibility='public', the other 'private'. The MAX() backfill
    // should pick 'public'.
    db.run(
      `INSERT INTO agent_sessions(
         id, user_id, project, status, created_at, updated_at, last_activity,
         kata_mode, kata_issue, kata_phase, prompt, visibility
       ) VALUES ('sess-pub', 'user-1', 'duraclaw', 'idle',
                 '2026-04-01', '2026-04-01', '2026-04-01',
                 'research', 42, NULL, 'p', 'public')`,
    )
    db.run(
      `INSERT INTO agent_sessions(
         id, user_id, project, status, created_at, updated_at, last_activity,
         kata_mode, kata_issue, kata_phase, prompt, visibility
       ) VALUES ('sess-priv', 'user-1', 'duraclaw', 'idle',
                 '2026-04-01', '2026-04-01', '2026-04-01',
                 'planning', 42, NULL, 'p', 'private')`,
    )

    // 0034 first (creates arcs + arc_id FK).
    applyMigration(db, migration0034)
    // Then 0036.
    applyMigration(db, migration0036)

    // Both sessions belong to the same arc.
    const sessRows = rows(
      db,
      `SELECT id, arc_id FROM agent_sessions WHERE id IN ('sess-pub','sess-priv')`,
    )
    expect(sessRows[0]!.arc_id).toBe(sessRows[1]!.arc_id)

    // The arc's visibility is 'public' (MAX wins over 'private').
    const arc = rows(db, `SELECT visibility FROM arcs WHERE id = '${sessRows[0]!.arc_id}'`)[0]
    expect(arc!.visibility).toBe('public')
  })

  it('backfills owner membership: every existing arc has its userId user inserted as owner', () => {
    insertUser(db, 'user-3')
    db.run(
      `INSERT INTO agent_sessions(
         id, user_id, project, status, created_at, updated_at, last_activity,
         kata_mode, kata_issue, kata_phase, prompt, visibility
       ) VALUES ('sess-x', 'user-3', 'duraclaw', 'idle',
                 '2026-04-01', '2026-04-01', '2026-04-01',
                 'research', 7, NULL, 'p', 'private')`,
    )

    applyMigration(db, migration0034)
    applyMigration(db, migration0036)

    const arcId = rows(db, `SELECT arc_id FROM agent_sessions WHERE id='sess-x'`)[0]!
      .arc_id as string

    const owners = rows(
      db,
      `SELECT user_id, role, added_at, added_by FROM arc_members
       WHERE arc_id='${arcId}' AND role='owner'`,
    )
    expect(owners).toHaveLength(1)
    expect(owners[0]!.user_id).toBe('user-3')
    // added_by is the user themselves (self-grant).
    expect(owners[0]!.added_by).toBe('user-3')
  })

  it('arcs without sessions default to visibility=private (COALESCE branch)', () => {
    // Arcs created post-0034 always have at least one session that
    // anchors them. To simulate the COALESCE branch we manually insert
    // an arc row AFTER 0034 but BEFORE 0036 with no sessions pointing
    // at it. The 0036 backfill UPDATE will then hit the COALESCE
    // fallback for that row.
    insertUser(db, 'user-9')
    applyMigration(db, migration0034)

    db.run(
      `INSERT INTO arcs(
         id, user_id, title, external_ref, worktree_id, status,
         parent_arc_id, created_at, updated_at, closed_at
       ) VALUES (
         'arc-empty', 'user-9', 'No sessions', NULL, NULL, 'draft',
         NULL, '2026-04-01', '2026-04-01', NULL
       )`,
    )

    applyMigration(db, migration0036)

    const arc = rows(db, `SELECT visibility FROM arcs WHERE id='arc-empty'`)[0]
    expect(arc!.visibility).toBe('private')
  })

  it('creates arc_members + arc_invitations tables with the correct columns', () => {
    insertUser(db, 'user-1')
    applyMigration(db, migration0034)
    applyMigration(db, migration0036)

    const memberCols = rows(db, `PRAGMA table_info(arc_members)`).map((r) => r.name as string)
    expect(memberCols).toEqual(
      expect.arrayContaining(['arc_id', 'user_id', 'role', 'added_at', 'added_by']),
    )

    const inviteCols = rows(db, `PRAGMA table_info(arc_invitations)`).map((r) => r.name as string)
    expect(inviteCols).toEqual(
      expect.arrayContaining([
        'token',
        'arc_id',
        'email',
        'role',
        'invited_by',
        'created_at',
        'expires_at',
        'accepted_at',
        'accepted_by',
      ]),
    )

    // arcs gained a visibility column; agent_sessions still has its
    // own (expand-only — drop ships in 0038).
    const arcCols = rows(db, `PRAGMA table_info(arcs)`).map((r) => r.name as string)
    expect(arcCols).toContain('visibility')
    const sessCols = rows(db, `PRAGMA table_info(agent_sessions)`).map((r) => r.name as string)
    expect(sessCols).toContain('visibility')
  })
})

// ── GH#152 P1.3 WU-A — migration 0037 (chat_mirror) ────────────────────
//
// 0037 adds the D1 mirror table for per-arc team chat. The DO holds the
// source-of-truth row; D1 mirrors are for cold-load + cross-arc surfaces.
// Tested:
//   - table created with the expected columns + nullability
//   - the two indexes exist with the expected key columns
//   - a round-trip INSERT + SELECT works under the FK constraints
describe('migration 0037 — chat_mirror', () => {
  const migration0034 = readMigration('0034_arcs_first_class.sql')
  const migration0036 = readMigration('0036_arc_collab_acl.sql')
  const migration0037 = readMigration('0037_chat_mirror.sql')
  let db: SqlJsDatabase

  beforeEach(async () => {
    const SqlJs = await getSQL()
    db = new SqlJs.Database()
    seedPreMigrationSchema(db)
    // FK enforcement is off by default in sql.js; the round-trip test
    // turns it on explicitly so the FK columns are exercised.
    db.run(`PRAGMA foreign_keys = ON;`)
    // Need 0034 (arcs table for FK target) + 0036 (arc_members; harmless
    // here but keeps the prefix order matching prod).
    insertUser(db, 'user-1')
    insertAgentSession(db, {
      id: 'sess-anchor',
      userId: 'user-1',
      kataIssue: 1,
      kataMode: 'research',
    })
    applyMigration(db, migration0034)
    applyMigration(db, migration0036)
  })

  it('creates chat_mirror with the expected columns + nullability', () => {
    applyMigration(db, migration0037)

    const cols = rows(db, `PRAGMA table_info(chat_mirror)`)
    const byName = Object.fromEntries(cols.map((c) => [c.name as string, c]))

    // Required columns present.
    for (const col of [
      'id',
      'arc_id',
      'author_user_id',
      'body',
      'mentions',
      'created_at',
      'modified_at',
      'edited_at',
      'deleted_at',
      'deleted_by',
    ]) {
      expect(byName[col]).toBeDefined()
    }

    // PK on id.
    expect(byName.id!.pk).toBe(1)

    // NOT NULL columns: id, arc_id, author_user_id, body, created_at, modified_at.
    // (`pk` columns are inherently NOT NULL but PRAGMA still flags `notnull`.)
    expect(byName.arc_id!.notnull).toBe(1)
    expect(byName.author_user_id!.notnull).toBe(1)
    expect(byName.body!.notnull).toBe(1)
    expect(byName.created_at!.notnull).toBe(1)
    expect(byName.modified_at!.notnull).toBe(1)

    // Nullable columns: mentions, edited_at, deleted_at, deleted_by.
    expect(byName.mentions!.notnull).toBe(0)
    expect(byName.edited_at!.notnull).toBe(0)
    expect(byName.deleted_at!.notnull).toBe(0)
    expect(byName.deleted_by!.notnull).toBe(0)
  })

  it('creates the (arc_id, created_at) and (author_user_id) indexes', () => {
    applyMigration(db, migration0037)

    const idxList = rows(db, `PRAGMA index_list('chat_mirror')`)
    const names = idxList.map((r) => r.name as string)
    expect(names).toContain('idx_chat_mirror_arc_created')
    expect(names).toContain('idx_chat_mirror_author')

    const arcCreatedCols = rows(db, `PRAGMA index_info('idx_chat_mirror_arc_created')`)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((r) => r.name as string)
    expect(arcCreatedCols).toEqual(['arc_id', 'created_at'])

    const authorCols = rows(db, `PRAGMA index_info('idx_chat_mirror_author')`).map(
      (r) => r.name as string,
    )
    expect(authorCols).toEqual(['author_user_id'])
  })

  it('round-trip INSERT + SELECT works (with FKs satisfied)', () => {
    applyMigration(db, migration0037)

    // The seeded sess-anchor created an arc — grab its id.
    const arcId = rows(db, `SELECT arc_id FROM agent_sessions WHERE id = 'sess-anchor' LIMIT 1`)[0]!
      .arc_id as string

    db.run(
      `INSERT INTO chat_mirror(
         id, arc_id, author_user_id, body, mentions,
         created_at, modified_at, edited_at, deleted_at, deleted_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        'chat-1',
        arcId,
        'user-1',
        'hello team',
        null,
        '2026-05-02T00:00:00Z',
        '2026-05-02T00:00:00Z',
      ],
    )

    const got = rows(db, `SELECT id, arc_id, author_user_id, body FROM chat_mirror`)
    expect(got).toHaveLength(1)
    expect(got[0]!.id).toBe('chat-1')
    expect(got[0]!.arc_id).toBe(arcId)
    expect(got[0]!.author_user_id).toBe('user-1')
    expect(got[0]!.body).toBe('hello team')
  })
})

describe('migration 0038 — drops agent_sessions.visibility (precondition guard)', () => {
  const migration0034 = readMigration('0034_arcs_first_class.sql')
  const migration0036 = readMigration('0036_arc_collab_acl.sql')
  let db: SqlJsDatabase

  beforeEach(async () => {
    const SqlJs = await getSQL()
    db = new SqlJs.Database()
    seedPreMigrationSchema(db)
  })

  it('after 0036, the 0038 precondition (no NULL arcs.visibility) holds', () => {
    insertUser(db, 'user-1')
    db.run(
      `INSERT INTO agent_sessions(
         id, user_id, project, status, created_at, updated_at, last_activity,
         kata_mode, kata_issue, kata_phase, prompt, visibility
       ) VALUES ('sess-1', 'user-1', 'duraclaw', 'idle',
                 '2026-04-01', '2026-04-01', '2026-04-01',
                 'research', 11, NULL, 'p', 'public')`,
    )
    db.run(
      `INSERT INTO agent_sessions(
         id, user_id, project, status, created_at, updated_at, last_activity,
         kata_mode, kata_issue, kata_phase, prompt, visibility
       ) VALUES ('sess-2', 'user-1', 'duraclaw', 'idle',
                 '2026-04-01', '2026-04-01', '2026-04-01',
                 'planning', 12, NULL, 'p', 'private')`,
    )

    applyMigration(db, migration0034)
    applyMigration(db, migration0036)

    // The deploy precondition the 0038 header documents.
    const nullCount = rows(db, `SELECT COUNT(*) AS n FROM arcs WHERE visibility IS NULL`)[0]!
    expect(Number(nullCount.n)).toBe(0)
  })
})
