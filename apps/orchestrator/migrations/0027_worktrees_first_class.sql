-- GH#115 P1: worktrees-first-class — reshape worktree_reservations into a
-- registry over /data/projects/* clones, decoupled from kataIssue. Adds
-- agent_sessions.worktreeId FK; drops dead worktree_info_json column.
--
-- Uses the SQLite-canonical CREATE-TABLE-AS-SELECT rebuild pattern: SQLite
-- cannot ADD a PRIMARY KEY via ALTER, and the reshape needs a new PK on
-- `id` plus multi-column DROP. See spec §B-MIGRATION-1.
--
-- Pre-flight: take a D1 backup with
--   wrangler d1 export duraclaw-auth --output=apps/orchestrator/migrations/backups/pre-0027.sql
-- BEFORE applying this migration. Rollback fixture; see backups/README.md.

-- 1. Pre-clean stale rows (by definition not actively held).
DELETE FROM worktree_reservations WHERE stale = 1;
--> statement-breakpoint

-- 2. New target table.
CREATE TABLE worktrees_new (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  branch TEXT,
  status TEXT NOT NULL CHECK (status IN ('free','held','active','cleanup')) DEFAULT 'held',
  reservedBy TEXT,
  released_at INTEGER,
  createdAt INTEGER NOT NULL,
  lastTouchedAt INTEGER NOT NULL,
  ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint

-- 3. Backfill from worktree_reservations. Random 8-byte hex id;
--    reservedBy = {kind:'arc', id:issue_number}; held status; timestamps
--    converted from ISO-8601 text to unix-ms. NULL or malformed
--    held_since / last_activity_at fall back to now() via COALESCE so
--    the backfill can't fail on legacy rows missing those fields.
INSERT INTO worktrees_new (id, path, branch, status, reservedBy, released_at, createdAt, lastTouchedAt, ownerId)
SELECT
  lower(hex(randomblob(8))),
  '/data/projects/' || worktree,
  NULL,
  'held',
  json_object('kind','arc','id', issue_number),
  NULL,
  COALESCE(CAST(strftime('%s', held_since) AS INTEGER) * 1000, unixepoch() * 1000),
  COALESCE(CAST(strftime('%s', last_activity_at) AS INTEGER) * 1000, unixepoch() * 1000),
  owner_id
FROM worktree_reservations;
--> statement-breakpoint

-- 4. Drop legacy table.
DROP TABLE worktree_reservations;
--> statement-breakpoint

-- 5. Rename rebuilt table into place.
ALTER TABLE worktrees_new RENAME TO worktrees;
--> statement-breakpoint

-- 6. JSON expression index for reservedBy lookups (kind+id).
CREATE INDEX idx_worktrees_reservedBy ON worktrees(
  json_extract(reservedBy, '$.kind'),
  json_extract(reservedBy, '$.id')
);
--> statement-breakpoint

-- 7. agent_sessions.worktreeId FK column (additive).
ALTER TABLE agent_sessions ADD COLUMN worktreeId TEXT REFERENCES worktrees(id);
--> statement-breakpoint

-- 8. Backfill agent_sessions.worktreeId by joining on (kataIssue, project).
--    The pre-migration worktree_reservations had a 1:1 mapping with
--    (issue_number, worktree); the new worktrees rows preserve that via
--    json_extract on reservedBy. Sessions where the reservation was
--    pre-stale (deleted in step 1) will get NULL — acceptable, kata's
--    auto-reserve will fix them on next mode entry.
UPDATE agent_sessions SET worktreeId = (
  SELECT id FROM worktrees
  WHERE json_extract(reservedBy,'$.id') = agent_sessions.kata_issue
    AND path = '/data/projects/' || agent_sessions.project
);
--> statement-breakpoint

-- 9. Drop dead column. SQLite >= 3.35 (D1 is current) supports
--    per-column DROP; this is safe as a standalone statement.
ALTER TABLE agent_sessions DROP COLUMN worktree_info_json;
