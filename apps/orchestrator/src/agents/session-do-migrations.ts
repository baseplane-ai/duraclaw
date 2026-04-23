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
  {
    version: 6,
    description: 'Add typed session_meta table for per-session server state (B1)',
    up: (sql) => {
      sql.exec(`CREATE TABLE IF NOT EXISTS session_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        message_seq INTEGER NOT NULL DEFAULT 0,
        sdk_session_id TEXT,
        active_callback_token TEXT,
        context_usage_json TEXT,
        context_usage_cached_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`)
      sql.exec(`INSERT OR IGNORE INTO session_meta (id, updated_at) VALUES (1, 0)`)
    },
  },
  {
    version: 7,
    description: 'Expand session_meta with ex-SessionState fields (B10 #31)',
    up: (sql) => {
      const addCol = (col: string, ddl: string) => {
        try {
          sql.exec(`ALTER TABLE session_meta ADD COLUMN ${col} ${ddl}`)
        } catch (e: unknown) {
          // Only swallow the idempotent "column already exists" case. Anything
          // else (corruption, permission failure, malformed DDL) must surface.
          const msg = e instanceof Error ? e.message : String(e)
          if (!msg.toLowerCase().includes('duplicate column')) {
            console.warn('[migration v7] unexpected error adding column', col, e)
            throw e
          }
        }
      }
      addCol('status', "TEXT NOT NULL DEFAULT 'idle'")
      addCol('session_id', 'TEXT')
      addCol('project', "TEXT NOT NULL DEFAULT ''")
      addCol('project_path', "TEXT NOT NULL DEFAULT ''")
      addCol('model', 'TEXT')
      addCol('prompt', "TEXT NOT NULL DEFAULT ''")
      addCol('user_id', 'TEXT')
      addCol('started_at', 'TEXT')
      addCol('completed_at', 'TEXT')
      addCol('num_turns', 'INTEGER NOT NULL DEFAULT 0')
      addCol('total_cost_usd', 'REAL')
      addCol('duration_ms', 'INTEGER')
      addCol('gate_json', 'TEXT')
      addCol('created_at', "TEXT NOT NULL DEFAULT ''")
      addCol('error', 'TEXT')
      addCol('summary', 'TEXT')
      addCol('last_kata_mode', 'TEXT')
    },
  },
  {
    version: 8,
    description:
      'No-op: messages `seq` column drop stub (column never existed — v4 renamed the messages table to _deprecated_messages; SDK Session owns assistant_messages which has no seq column). Kept for audit trail of the GH#38 migration.',
    up: (_sql) => {
      // Intentional no-op. See description.
    },
  },
  {
    version: 9,
    description:
      'Add composite index on assistant_messages(session_id, created_at, id) to back the GET /messages keyset-pagination cursor query. Safe to create against the SDK-owned table via CREATE INDEX IF NOT EXISTS — will not conflict with SDK-managed schema.',
    up: (sql) => {
      try {
        sql.exec(
          `CREATE INDEX IF NOT EXISTS idx_assistant_messages_session_created_id
            ON assistant_messages (session_id, created_at, id)`,
        )
      } catch (e: unknown) {
        // The table is created lazily by the SDK Session class on first use.
        // If it doesn't exist yet in this DO (no SDK activity ever), skip —
        // a fresh DO will create the index on first cursor query via the
        // SDK's schema initialisation path is unaffected; this migration
        // is a best-effort perf optimisation, not a correctness gate.
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.toLowerCase().includes('no such table')) {
          console.warn('[migration v9] unexpected error creating index', e)
          throw e
        }
      }
    },
  },
  {
    version: 10,
    description:
      'Add modified_at column + index to assistant_messages for cursor-based replay of in-place updates. Fixes: reconnect after tab-background during long tool-heavy turns missed final assistant text because replayMessagesFromCursor used strictly-greater (created_at, id) keyset — in-place updates to rows behind the cursor were never replayed.',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE assistant_messages ADD COLUMN modified_at TEXT`)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (
          !msg.toLowerCase().includes('duplicate column') &&
          !msg.toLowerCase().includes('no such table')
        ) {
          console.warn('[migration v10] unexpected error adding modified_at column', e)
          throw e
        }
      }
      try {
        sql.exec(
          `CREATE INDEX IF NOT EXISTS idx_assistant_messages_modified
            ON assistant_messages (session_id, modified_at)`,
        )
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.toLowerCase().includes('no such table')) {
          console.warn('[migration v10] unexpected error creating modified_at index', e)
          throw e
        }
      }
    },
  },
  {
    version: 11,
    description: 'Add last_event_ts to session_meta for hibernation-safe liveness (GH#69 B1)',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE session_meta ADD COLUMN last_event_ts INTEGER NOT NULL DEFAULT 0`)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.toLowerCase().includes('duplicate column')) {
          console.warn('[migration v11] unexpected error adding last_event_ts column', e)
          throw e
        }
      }
    },
  },
  {
    version: 12,
    description:
      'Add sender_id column to assistant_messages for multi-user collab (spec #68 B14). NULL for legacy rows (pre-shared-session).',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE assistant_messages ADD COLUMN sender_id TEXT`)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (
          !msg.toLowerCase().includes('duplicate column') &&
          !msg.toLowerCase().includes('no such table')
        ) {
          console.warn('[migration v12] unexpected error adding sender_id column', e)
          throw e
        }
      }
    },
  },
  {
    version: 13,
    description:
      'Unify cursor replay on modified_at: backfill modified_at = created_at for legacy rows and add composite (session_id, modified_at, id) index. Fixes: warm reconnect re-emitted every historically-modified row because replayMessagesFromCursor WHERE matched `modified_at > cursor.createdAt` but advanced cursor on `created_at` — so any row whose modified_at ticked forward during a past streaming burst kept re-qualifying forever. After v13, modified_at is non-null on every row and the replay cursor tracks it monotonically.',
    up: (sql) => {
      try {
        sql.exec(`UPDATE assistant_messages SET modified_at = created_at WHERE modified_at IS NULL`)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (
          !msg.toLowerCase().includes('no such table') &&
          !msg.toLowerCase().includes('no such column')
        ) {
          console.warn('[migration v13] unexpected error backfilling modified_at', e)
          throw e
        }
      }
      try {
        sql.exec(
          `CREATE INDEX IF NOT EXISTS idx_assistant_messages_session_modified_id
            ON assistant_messages (session_id, modified_at, id)`,
        )
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.toLowerCase().includes('no such table')) {
          console.warn('[migration v13] unexpected error creating composite index', e)
          throw e
        }
      }
    },
  },
  {
    version: 14,
    description:
      'Add last_run_ended to session_meta for chain auto-advance evidence gate (GH#73). 0/1 boolean; mirrors whether the runner has observed `.kata/sessions/<sdk-session-id>/run-end.json` for the current session.',
    up: (sql) => {
      try {
        sql.exec(`ALTER TABLE session_meta ADD COLUMN last_run_ended INTEGER NOT NULL DEFAULT 0`)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.toLowerCase().includes('duplicate column')) {
          console.warn('[migration v14] unexpected error adding last_run_ended column', e)
          throw e
        }
      }
    },
  },
]
