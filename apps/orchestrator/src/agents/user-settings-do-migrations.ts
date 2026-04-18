import type { Migration } from '~/lib/do-migrations'

export const USER_SETTINGS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Create tabs and drafts tables',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS tabs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`)

      sql.exec(`CREATE TABLE IF NOT EXISTS tab_state (
        key TEXT PRIMARY KEY,
        value TEXT
      )`)

      sql.exec(`CREATE TABLE IF NOT EXISTS drafts (
        tab_id TEXT PRIMARY KEY,
        text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`)
    },
  },
  {
    version: 2,
    description: 'Drop legacy drafts table — Y.Text on SessionCollabDO is the source of truth',
    up: (sql) => {
      sql.exec(`DROP TABLE IF EXISTS drafts`)
    },
  },
]
