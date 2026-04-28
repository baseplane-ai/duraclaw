-- GH#119 P2: runner_identities — admin-managed catalog of Claude runner
-- identities. Each row maps an identity name (e.g. 'work1') to a HOME
-- directory containing isolated Claude auth (~/.claude/.credentials.json
-- per identity). The DO selects an available identity via LRU at
-- triggerGatewayDial time and passes a derived HOME path to the gateway
-- as `runner_home`; the gateway sets HOME in the spawn env so the
-- runner picks up the identity-scoped credentials.
--
-- NOTE: the `home_path` column declared below is dropped by migration
-- 0030 (GH#129) — the HOME is now derived as `${IDENTITY_HOME_BASE}/${name}`
-- at use time. The column is retained in this migration for replay
-- correctness; fresh-bootstrap installs run 0028 → 0030 and end up with
-- the post-0030 schema.
--
-- Status values:
--   'available'  — selectable by LRU
--   'cooldown'   — temporarily unavailable (post-rate-limit; lazy expiry)
--   'disabled'   — admin-disabled, never selected
--
-- cooldown_until is a SQLite-format datetime string. The selection
-- query uses `cooldown_until < datetime('now')` for lazy expiry, so no
-- background cleanup job is needed.
-- NOTE: id has no DEFAULT — the application generates UUIDs via
-- Drizzle's $defaultFn(() => crypto.randomUUID()). SQL-only INSERTs
-- (e.g. via wrangler shell) MUST provide an explicit id.
CREATE TABLE IF NOT EXISTS runner_identities (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  home_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  cooldown_until TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runner_identities_status_cooldown
  ON runner_identities (status, cooldown_until);
CREATE INDEX IF NOT EXISTS idx_runner_identities_last_used_at
  ON runner_identities (last_used_at);
