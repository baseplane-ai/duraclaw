import type { Migration } from '~/lib/do-migrations'

export const REGISTRY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial sessions table',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        project TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        duration_ms INTEGER,
        total_cost_usd REAL,
        num_turns INTEGER,
        prompt TEXT,
        summary TEXT
      )`)
    },
  },
  {
    version: 2,
    description: 'Rename legacy worktree column',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE sessions RENAME COLUMN worktree TO project`)
      } catch {
        // Legacy column not present.
      }
    },
  },
  {
    version: 3,
    description: 'Add missing summary and user_id columns',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN summary TEXT`)
      } catch {
        // Column already exists.
      }

      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT`)
      } catch {
        // Column already exists.
      }
    },
  },
  {
    version: 4,
    description: 'Add archived column for session archiving',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
      } catch {
        // Column already exists.
      }
    },
  },
  {
    version: 5,
    description: 'Add title and tag columns for session operations',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN title TEXT`)
      } catch {
        // Column already exists.
      }
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN tag TEXT`)
      } catch {
        // Column already exists.
      }
    },
  },
  {
    version: 6,
    description: 'Add user_preferences table for user defaults',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY,
        permission_mode TEXT DEFAULT 'default',
        model TEXT DEFAULT 'claude-opus-4-6',
        max_budget REAL,
        thinking_mode TEXT DEFAULT 'adaptive',
        effort TEXT DEFAULT 'high',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`)
    },
  },
  {
    version: 7,
    description: 'Add session discovery columns: origin, agent, message_count, sdk_session_id',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN origin TEXT DEFAULT 'duraclaw'`)
      } catch {
        /* Column already exists */
      }
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN agent TEXT DEFAULT 'claude'`)
      } catch {
        /* Column already exists */
      }
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN message_count INTEGER`)
      } catch {
        /* Column already exists */
      }
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT`)
      } catch {
        /* Column already exists */
      }
      sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_sdk_id ON sessions(sdk_session_id) WHERE sdk_session_id IS NOT NULL`,
      )
    },
  },
  {
    version: 8,
    description: 'Add kata state columns for session cards',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN kata_mode TEXT`)
      } catch {
        /* Column already exists */
      }
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN kata_issue INTEGER`)
      } catch {
        /* Column already exists */
      }
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN kata_phase TEXT`)
      } catch {
        /* Column already exists */
      }
    },
  },
  {
    version: 9,
    description: 'Add last_activity column for gateway-sourced recency sorting',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE sessions ADD COLUMN last_activity TEXT`)
      } catch {
        /* Column already exists */
      }
      // Leave last_activity NULL — real values come from gateway discovery sync
    },
  },
  {
    version: 10,
    description: 'Clear backfilled last_activity — real values come from gateway sync',
    up: (sql) => {
      sql.exec(`UPDATE sessions SET last_activity = NULL`)
    },
  },
]
