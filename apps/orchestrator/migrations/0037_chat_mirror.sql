-- GH#152 P1.3 WU-A: D1 mirror of per-arc team chat (`chat_messages`).
--
-- Source of truth is the per-arc `ArcCollabDO` SQLite (created at DO
-- migration v8). The D1 mirror exists for cold-load queries (latest N
-- chat messages for an arc on first paint, before the WS Yjs / synced
-- collection wires up) and for cross-arc surfaces ("all messages by
-- user"). Writes happen on the orchestrator side after the DO RPC
-- succeeds; the DO is authoritative on conflict.
--
-- Column-shape note: the DO stores `created_at` / `modified_at` /
-- `edited_at` / `deleted_at` as epoch-ms INTEGER (DO convention for
-- the cursor-replay key); the D1 mirror stores them as ISO 8601 TEXT
-- to match the surrounding D1 norms (`agent_sessions`, `arcs`,
-- `arc_members` are all ISO 8601). The orchestrator's mirror writer
-- converts at the boundary.
--
-- D1 transaction caveat (mirrors the 0034 / 0036 headers): D1's
-- SQLite implementation does NOT allow CREATE/ALTER/DROP TABLE inside
-- an explicit BEGIN…COMMIT transaction; DDL auto-commits regardless.
-- This migration is therefore a sequence of statements separated by
-- `--> statement-breakpoint` markers. Atomicity is workflow-level.
--
-- Renumbered from spec's 0035 → 0037 because 0035
-- (projects_ownership), 0036 (arc_collab_acl), and 0038
-- (drop_session_visibility) were already taken when this migration
-- was authored. Spec lines 692-696 explicitly bless renumbering on
-- rebase.

-- 1. chat_mirror: one row per chat message. PK matches the DO's id
--    (string uuid stamped at insert time on the orchestrator side).
--    arc_id / author_user_id cascade so an arc or user delete cleans
--    up the mirror; deleted_by is SET NULL so the audit row survives
--    the deleter's account removal.
CREATE TABLE chat_mirror (
  id              text PRIMARY KEY,
  arc_id          text NOT NULL REFERENCES arcs(id)  ON DELETE CASCADE,
  author_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL,
  mentions        text,                       -- JSON array of resolved user ids; null/empty until P1.5
  created_at      text NOT NULL,              -- ISO 8601 (D1 convention; DO stores epoch ms)
  modified_at     text NOT NULL,
  edited_at       text,
  deleted_at      text,
  deleted_by      text REFERENCES users(id) ON DELETE SET NULL
);
--> statement-breakpoint

-- 2. Cold-load query: latest N chat messages per arc, newest first.
CREATE INDEX idx_chat_mirror_arc_created ON chat_mirror(arc_id, created_at DESC);
--> statement-breakpoint

-- 3. Future "all messages by user" surface — included now to avoid a
--    follow-up migration just for it.
CREATE INDEX idx_chat_mirror_author ON chat_mirror(author_user_id);
