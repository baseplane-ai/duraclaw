-- GH#86: Haiku-based session titler.
--
-- 1. Add `title_source` to agent_sessions for the never-clobber gate
--    (NULL = no title yet, 'haiku' = may be retitled, 'user' = frozen).
--    The PATCH /api/sessions/:id handler stamps 'user' alongside any
--    user-provided `title`. The DO's `case 'title_update':` discards
--    runner events when title_source = 'user'.
--
-- 2. Create generic `feature_flags` table — global flags read at
--    spawn-time by SessionDO.triggerGatewayDial (5-min cached).
--    First consumer: 'haiku_titler'. Future consumers reuse the
--    table + admin CRUD without schema churn.
ALTER TABLE agent_sessions ADD COLUMN title_source TEXT;

CREATE TABLE feature_flags (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Seed the haiku_titler flag on (admin can disable via PATCH).
INSERT INTO feature_flags (id, enabled, updated_at)
  VALUES ('haiku_titler', 1, datetime('now'));
