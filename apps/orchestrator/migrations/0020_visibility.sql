-- 0020: Add visibility column to agent_sessions + projects (spec #68 B1)
ALTER TABLE agent_sessions ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
CREATE INDEX idx_agent_sessions_visibility_last_activity
  ON agent_sessions (visibility, last_activity);
