-- GH#152 P1: per-arc ACL foundation for team collab (chat + comments).
--
-- Expand-only migration: adds the new collab tables (arc_members,
-- arc_invitations) and the new arcs.visibility column, backfills
-- visibility from agent_sessions.visibility, and auto-grants 'owner'
-- membership to each arc's creator. Does NOT drop
-- agent_sessions.visibility — that destructive contract phase ships in
-- a SEPARATE follow-up migration (0038_drop_session_visibility.sql)
-- AFTER this migration has been live for at least one full deploy
-- cycle and a post-deploy spot-check confirms the backfill (Gotcha #4
-- in spec line 953).
--
-- D1 transaction caveat (mirrors the 0034_arcs_first_class.sql header):
-- D1's SQLite implementation does NOT allow CREATE/ALTER/DROP TABLE
-- inside an explicit BEGIN…COMMIT transaction; DDL auto-commits
-- regardless. This migration is therefore a sequence of statements
-- separated by `--> statement-breakpoint` markers (matching the
-- 0031/0034 pattern). Atomicity is workflow-level: if any statement
-- fails, wrangler marks the migration failed and the dev wipes local
-- D1 to retry. Pre-prod tolerates this; expand-then-contract guards
-- prod against partial application of the destructive drop.
--
-- Renumbered from spec's 0034 → 0036 because 0034 (arcs_first_class)
-- and 0035 (projects_ownership) shipped after the spec was authored.
-- Spec lines 692-696 explicitly bless renumbering on rebase. Skipping
-- 0033 (mysteriously missing, likely in-flight in another branch).

-- 1. arc_members: per-arc ACL junction. Composite PK (arc_id, user_id)
--    so a user appears at most once per arc. ON DELETE CASCADE on both
--    FKs so removing an arc or a user cleans up membership rows.
CREATE TABLE arc_members (
  arc_id    TEXT NOT NULL REFERENCES arcs(id)  ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  added_at  TEXT NOT NULL,
  added_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (arc_id, user_id)
);
--> statement-breakpoint

-- 2. Per-user 'arcs I'm in' lookup index.
CREATE INDEX idx_arc_members_user ON arc_members(user_id, arc_id);
--> statement-breakpoint

-- 3. arc_invitations: pending email invites. Token is the PK so the
--    /invitations/<token>/accept route is a single-row lookup. Accepted
--    invites are kept (accepted_at + accepted_by) for audit; the
--    pending-invitations index excludes them via partial WHERE clause.
CREATE TABLE arc_invitations (
  token        TEXT PRIMARY KEY,
  arc_id       TEXT NOT NULL REFERENCES arcs(id)  ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  invited_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  accepted_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);
--> statement-breakpoint

-- 4. Pending invitations per arc (excludes accepted rows).
CREATE INDEX idx_arc_invitations_arc ON arc_invitations(arc_id) WHERE accepted_at IS NULL;
--> statement-breakpoint

-- 5. arcs.visibility column. Defaults to 'private' so any row not
--    touched by the backfill below stays private. CHECK enforces enum.
ALTER TABLE arcs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public'));
--> statement-breakpoint

-- 6. Backfill from agent_sessions.visibility. MAX() puts 'public'
--    before 'private' lexicographically, so an arc with ANY public
--    session becomes 'public' (matching today's user-visible behavior
--    where public sessions are discoverable). COALESCE handles arcs
--    with no sessions (default to 'private').
UPDATE arcs SET visibility = COALESCE(
  (SELECT MAX(visibility) FROM agent_sessions WHERE arc_id = arcs.id),
  'private'
);
--> statement-breakpoint

-- 7. Auto-grant 'owner' membership to each arc's creator. Uses the
--    arc's created_at timestamp so member rows have a sensible
--    added_at, and added_by = the user themselves (self-grant during
--    backfill).
INSERT INTO arc_members(arc_id, user_id, role, added_at, added_by)
SELECT id, user_id, 'owner', created_at, user_id FROM arcs;
--> statement-breakpoint

-- 8. Composite index for kanban + discoverability queries
--    (visibility, status).
CREATE INDEX idx_arcs_visibility_status ON arcs(visibility, status);
