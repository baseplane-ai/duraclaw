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
  {
    version: 3,
    description: 'Add events and kv tables for raw event persistence and kata state',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data TEXT,
        ts INTEGER
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`)
    },
  },
  {
    version: 4,
    description: 'Rename old tables to _deprecated (Session class manages its own tables)',
    up: (sql) => {
      sql.exec(`ALTER TABLE messages RENAME TO _deprecated_messages`)
      sql.exec(`ALTER TABLE events RENAME TO _deprecated_events`)
      // kv table stays — still used for kata_state
    },
  },
  {
    version: 5,
    description: 'Add submit_ids table for sendMessage idempotency (yjs multiplayer draft)',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS submit_ids (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`)
    },
  },
]
