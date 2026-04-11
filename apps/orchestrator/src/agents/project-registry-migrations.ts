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
]
