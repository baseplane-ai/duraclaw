-- GH#116 P1: arcs as first-class durable parent of every session.
--
-- Creates the `arcs` table, backfills it from the kata-linked sessions
-- and from arc-less sessions (each gets its own implicit arc), reshapes
-- agent_sessions to point at arcs (`arc_id`), renames `kata_mode` →
-- `mode`, adds `parent_session_id`, and drops the kata trio
-- (`kata_mode`, `kata_issue`, `kata_phase`). `kata_state_json` is
-- PRESERVED — KataStatePanel still reads it for UI rendering.
--
-- D1 transaction caveat (Gotcha #11): D1's SQLite implementation does
-- NOT allow CREATE/ALTER/DROP TABLE inside an explicit BEGIN…COMMIT
-- transaction; DDL auto-commits regardless. This migration is therefore
-- a sequence of statements separated by `--> statement-breakpoint`
-- markers (matching the 0031 pattern). Atomicity is workflow-level: if
-- any statement fails, wrangler marks the migration failed and the dev
-- wipes local D1 to retry. Pre-prod tolerates this.
--
-- arc_id NOT NULL is enforced at the Drizzle + app layer only. SQLite
-- can't ALTER an existing column to add NOT NULL without a table
-- recreate, and the auth `sessions` table collision rules out the
-- rename-to-clean-table path (Gotcha #12 + #13). The migration adds
-- arc_id nullable, backfills it from kata_issue / orphan rows, and
-- leaves the column nullable at the DB layer.
--
-- The `worktree_reservations` table was already dropped by GH#115's
-- migration 0031; the worktree FK on arcs points directly at
-- `worktrees(id)`.

-- 1. Create arcs table.
CREATE TABLE arcs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  external_ref text,
  worktree_id text REFERENCES worktrees(id),
  status text NOT NULL DEFAULT 'draft',
  parent_arc_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  closed_at text
);
--> statement-breakpoint

-- 2. Expression unique index on externalRef (provider, id) — one arc
--    per GH issue per user. user_id is a leading key column so two
--    different users can each own an arc for the same GH issue (the
--    backfill mints one arc per (user_id, kata_issue) pair below);
--    omitting user_id makes the backfill collide on the second user
--    that ever opened the same issue. WHERE clause skips draft /
--    orphan arcs (external_ref NULL).
CREATE UNIQUE INDEX idx_arcs_external_ref
  ON arcs(user_id, json_extract(external_ref, '$.provider'), json_extract(external_ref, '$.id'))
  WHERE external_ref IS NOT NULL;
--> statement-breakpoint

-- 3. Composite index for kanban queries (user_id, status).
CREATE INDEX idx_arcs_user_status_lastactivity ON arcs(user_id, status);
--> statement-breakpoint

-- 4. Backfill: one arc per (user_id, kata_issue) pair for kata-linked
--    sessions. createdAt = MIN(session.createdAt); updatedAt =
--    MAX(session.lastActivity OR createdAt). status = 'open' (these
--    arcs already had work happening on them — they aren't drafts).
INSERT INTO arcs(id, user_id, title, external_ref, status, created_at, updated_at)
SELECT
  'arc_' || lower(hex(randomblob(8))) AS id,
  user_id,
  COALESCE('Issue #' || kata_issue, 'Untitled arc') AS title,
  json_object(
    'provider', 'github',
    'id', kata_issue,
    'url', 'https://github.com/baseplane-ai/duraclaw/issues/' || kata_issue
  ) AS external_ref,
  'open' AS status,
  MIN(created_at) AS created_at,
  MAX(COALESCE(last_activity, created_at)) AS updated_at
FROM agent_sessions
WHERE kata_issue IS NOT NULL
GROUP BY user_id, kata_issue;
--> statement-breakpoint

-- 5. Backfill: one implicit arc per orphan session (kata_issue IS
--    NULL). Title fallback: first 50 chars of prompt, or
--    'Untitled session'. Status = 'draft' so the sidebar renders
--    these as flat session rows (B4 / Gotcha #7).
INSERT INTO arcs(id, user_id, title, external_ref, status, created_at, updated_at)
SELECT
  'arc_orphan_' || s.id AS id,
  s.user_id,
  COALESCE(SUBSTR(s.prompt, 1, 50), 'Untitled session') AS title,
  NULL AS external_ref,
  'draft' AS status,
  s.created_at,
  COALESCE(s.last_activity, s.created_at) AS updated_at
FROM agent_sessions s
WHERE s.kata_issue IS NULL;
--> statement-breakpoint

-- 6. Add arc_id column to agent_sessions (nullable initially; NOT NULL
--    enforced at the Drizzle/app layer only — see header).
ALTER TABLE agent_sessions ADD COLUMN arc_id text;
--> statement-breakpoint

-- 7. Add mode column (renamed from kata_mode; same nullable text shape).
ALTER TABLE agent_sessions ADD COLUMN mode text;
--> statement-breakpoint

-- 8. Add parent_session_id column (self-FK; NULL for root sessions).
ALTER TABLE agent_sessions ADD COLUMN parent_session_id text;
--> statement-breakpoint

-- 9. Backfill arc_id for kata-linked sessions: join on (user_id,
--    kata_issue) → arcs row created in step 4.
UPDATE agent_sessions
SET arc_id = (
  SELECT a.id FROM arcs a
  WHERE a.user_id = agent_sessions.user_id
    AND json_extract(a.external_ref, '$.id') = agent_sessions.kata_issue
)
WHERE kata_issue IS NOT NULL;
--> statement-breakpoint

-- 10. Backfill arc_id for orphan sessions: 1:1 by id (matches the
--     'arc_orphan_' || id construction in step 5).
UPDATE agent_sessions
SET arc_id = 'arc_orphan_' || id
WHERE kata_issue IS NULL;
--> statement-breakpoint

-- 11. Backfill mode from kata_mode.
UPDATE agent_sessions SET mode = kata_mode;
--> statement-breakpoint

-- 12. Backfill arcs.worktree_id from agent_sessions.worktreeId. The
--     agent_sessions.worktreeId column is camelCase (added by GH#115's
--     migration 0031 line 66); we use that exact name in the SELECT.
--     For each external-ref'd arc, pick any one of its sessions'
--     worktreeId (LIMIT 1 — multi-session arcs typically share one
--     worktree per the kata reservation invariant).
UPDATE arcs SET worktree_id = (
  SELECT s.worktreeId FROM agent_sessions s
  WHERE s.kata_issue = json_extract(arcs.external_ref, '$.id')
    AND s.worktreeId IS NOT NULL
  LIMIT 1
)
WHERE external_ref IS NOT NULL;
--> statement-breakpoint

-- 13. Drop kata_mode (replaced by `mode`).
ALTER TABLE agent_sessions DROP COLUMN kata_mode;
--> statement-breakpoint

-- 14. Drop kata_issue (replaced by `arc_id` → arcs.external_ref).
ALTER TABLE agent_sessions DROP COLUMN kata_issue;
--> statement-breakpoint

-- 15. Drop kata_phase (no replacement — phase tracking lives in kata's
--     internal state.json, not in the D1 row).
ALTER TABLE agent_sessions DROP COLUMN kata_phase;
--> statement-breakpoint

-- 16. Partial unique index on (arc_id, mode) WHERE status IN
--     ('idle','pending','running') AND mode IS NOT NULL. Closes the
--     auto-advance idempotency race (B17) — two concurrent `stopped`
--     events can no longer spawn duplicate successors for the same
--     (arc, mode) tuple. The `mode IS NOT NULL` clause is required
--     because SQLite treats NULLs as distinct in UNIQUE indexes; without
--     it two `(arcId, NULL, status='running')` rows would not collide,
--     so the index would silently fail to enforce idempotency for
--     null-mode sessions. Null-mode sessions (implicit-arc / debug /
--     freeform / pre-mode-set) intentionally do not collide — only
--     non-null modes participate in advance idempotency.
--     The pre-existing four agent_sessions indexes (runner_id_unique,
--     user_last_activity, user_project, visibility_last_activity) are
--     unchanged: SQLite ≥3.35 preserves indexes across ADD/DROP COLUMN.
CREATE UNIQUE INDEX idx_agent_sessions_arc_mode_active
  ON agent_sessions(arc_id, mode)
  WHERE status IN ('idle', 'pending', 'running') AND mode IS NOT NULL;
