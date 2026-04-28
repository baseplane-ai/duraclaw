CREATE TABLE IF NOT EXISTS gemini_models (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  context_window INTEGER NOT NULL,
  max_output_tokens INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO gemini_models (id, name, context_window) VALUES
  ('auto-gemini-3', 'auto-gemini-3', 1000000),
  ('gemini-3-flash-preview', 'gemini-3-flash-preview', 200000),
  ('gemini-3-pro-preview', 'gemini-3-pro-preview', 1000000),
  ('gemini-3.1-flash-preview', 'gemini-3.1-flash-preview', 200000),
  ('gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', 1000000);
