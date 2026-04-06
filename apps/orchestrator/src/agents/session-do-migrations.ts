import type { Migration } from '~/lib/do-migrations'

export const SESSION_DO_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial messages table',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL DEFAULT 'assistant',
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`)
    },
  },
  {
    version: 2,
    description: 'Add forward-compatible message columns',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE messages ADD COLUMN session_id TEXT`)
      } catch {
        // Column already exists.
      }

      try {
        sql.exec(`ALTER TABLE messages ADD COLUMN metadata TEXT`)
      } catch {
        // Column already exists.
      }
    },
  },
]
