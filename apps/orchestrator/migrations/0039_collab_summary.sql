-- GH#152 P1.5 (WU-A): per-user collab summary tables — unread counters
-- and @-mention inbox. Powers the per-arc unread badge and the global
-- /inbox view.
--
-- arc_unread is a per-(user, arc) counter pair. Split into per-channel
-- (`unread_comments` / `unread_chat`) and per-channel last-read
-- timestamps so the comments tab and chat tab can be independently
-- "marked read" without clobbering the other channel's counter. Both
-- counters and timestamps are app-managed (incremented on write,
-- cleared on POST /api/arcs/:id/read in WU-B).
--
-- arc_mentions is one row per @-mention emission, written by
-- addCommentImpl / addChatImpl after parseMentions resolves the body.
-- Carries `actor_user_id` + `preview` denormalized so the Inbox view
-- renders without a JOIN against chat_mirror / comments. `read_at` is
-- nullable; cleared in bulk by POST /api/arcs/:id/read alongside the
-- counter reset.
--
-- Renumbered from spec's 0037 → 0039 because 0037 was claimed by
-- P1.3's chat_mirror and 0038 by P1.1's drop_session_visibility. Spec
-- lines 692-696 explicitly bless renumbering on rebase. 0039 is the
-- next free prefix.
--
-- D1 transaction caveat (mirrors the 0036 header): D1's SQLite
-- implementation does NOT allow CREATE TABLE inside an explicit
-- BEGIN…COMMIT transaction; DDL auto-commits regardless. This migration
-- is therefore a sequence of statements separated by `--> statement-
-- breakpoint` markers. Atomicity is workflow-level.

CREATE TABLE arc_unread (
  user_id                text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arc_id                 text NOT NULL REFERENCES arcs(id)  ON DELETE CASCADE,
  unread_comments        integer NOT NULL DEFAULT 0,
  unread_chat            integer NOT NULL DEFAULT 0,
  last_read_comments_at  text,
  last_read_chat_at      text,
  PRIMARY KEY (user_id, arc_id)
);
--> statement-breakpoint

CREATE TABLE arc_mentions (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arc_id         text NOT NULL REFERENCES arcs(id)  ON DELETE CASCADE,
  source_kind    text NOT NULL CHECK(source_kind IN ('comment','chat')),
  source_id      text NOT NULL,
  actor_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preview        text NOT NULL,
  mention_ts     text NOT NULL,
  read_at        text
);
--> statement-breakpoint

-- Inbox query: latest mentions for a user, newest first.
CREATE INDEX idx_arc_mentions_user_ts ON arc_mentions(user_id, mention_ts DESC);
--> statement-breakpoint

-- Source lookup: find / dedupe mentions tied to a specific comment or
-- chat row (e.g. for delete propagation in a future phase).
CREATE INDEX idx_arc_mentions_source ON arc_mentions(source_kind, source_id);
