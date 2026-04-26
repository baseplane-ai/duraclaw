-- Spec #101 P1.2: rename agent_sessions.sdk_session_id -> runner_session_id
-- and add capabilities_json column.
--
-- 1. Decouple terminology from "Claude Agent SDK" so the column reads as
--    "the runner's adapter-internal session id" (Claude SDK session_id,
--    Codex thread_id, or any future adapter's id). No semantic change —
--    the column still holds whatever the adapter reports on session.init.
--
-- 2. Add capabilities_json: TEXT JSON of AdapterCapabilities relayed by
--    the runner on session.init. NULL = legacy / pre-capability runner;
--    consumers fall back to the historical Claude SDK behavior.
--
-- RENAME COLUMN requires SQLite 3.25+ (CF D1 ships 3.45+).
-- The unique index on the old column is dropped and recreated under the
-- new name to keep `EXPLAIN` plans readable in the new world.
DROP INDEX IF EXISTS idx_agent_sessions_sdk_id;

ALTER TABLE agent_sessions RENAME COLUMN sdk_session_id TO runner_session_id;

ALTER TABLE agent_sessions ADD COLUMN capabilities_json TEXT;

CREATE UNIQUE INDEX idx_agent_sessions_runner_id
  ON agent_sessions (runner_session_id)
  WHERE runner_session_id IS NOT NULL;
