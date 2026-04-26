-- GH#107 P2: codex_models — admin-managed catalog of OpenAI Codex models.
--
-- Each row carries an admin-entered context window (OpenAI publishes no
-- machine-readable source), seeded with two known-good entries. The DO
-- reads `WHERE enabled = 1` on `triggerGatewayDial` for codex sessions
-- and injects the result onto the spawn payload as `cmd.codex_models`.
-- The runner uses the list for `availableProviders` capability + the
-- per-turn context-usage math.
CREATE TABLE IF NOT EXISTS codex_models (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  context_window INTEGER NOT NULL,
  max_output_tokens INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO codex_models (id, name, context_window) VALUES
  ('gpt-5.1', 'gpt-5.1', 1000000),
  ('o4-mini', 'o4-mini', 200000);
