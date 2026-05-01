/**
 * TanStack DB SQLite persistence adapter backed by op-sqlite.
 *
 * Mirrors the shape of @tanstack/capacitor-db-sqlite-persistence:
 * - Implements the `SQLiteDriver` contract from
 *   `@tanstack/db-sqlite-persistence-core` against op-sqlite's JSI API.
 * - Wraps the driver in `createSQLiteCorePersistenceAdapter({ driver })`
 *   to get a `PersistenceAdapter`, then bundles it with a
 *   `SingleProcessCoordinator` to satisfy the
 *   `PersistedCollectionPersistence` shape that
 *   `persistedCollectionOptions` consumes.
 *
 * Why a separate driver instead of reusing the Capacitor one:
 * - Capacitor's `SQLiteDBConnection` has its own query/execute API
 *   shape (`db.query(sql, params).values`, `db.run(sql, params)`).
 * - op-sqlite's API is closer to better-sqlite3 / wa-sqlite:
 *   `db.execute(sql, params)` returns `{ rows, rowsAffected }`.
 *   Different shape, same JSI ergonomics.
 *
 * Concurrency: the driver serialises operations on a per-database
 * promise queue so transactional sections can't interleave with
 * non-transactional reads/writes. Matches the Capacitor driver's
 * design (see `capacitor-sqlite-driver.d.ts`).
 *
 * Migration policy: none. RN target is fresh install; users get an
 * empty op-sqlite DB and resync from the server on first connect.
 * `schemaMismatchPolicy: 'reset'` is the recommended default.
 */

import type { DB } from '@op-engineering/op-sqlite'
import {
  createSQLiteCorePersistenceAdapter,
  type PersistedCollectionCoordinator,
  type PersistedCollectionPersistence,
  SingleProcessCoordinator,
  type SQLiteDriver,
} from '@tanstack/db-sqlite-persistence-core'

export type OpSqliteDatabase = DB

export type OpSqlitePersistenceOptions = {
  database: OpSqliteDatabase
  coordinator?: PersistedCollectionCoordinator
  schemaVersion?: number
  schemaMismatchPolicy?: 'sync-present-reset' | 'sync-absent-error' | 'reset'
}

class OpSqliteDriver implements SQLiteDriver {
  private readonly database: OpSqliteDatabase
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: { database: OpSqliteDatabase }) {
    this.database = options.database
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(async () => {
      // op-sqlite's execute handles multi-statement SQL via the
      // semicolon separator; for single statements it returns the same
      // result envelope. We don't need the result here.
      await this.database.execute(sql)
    })
  }

  async query<T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> {
    return this.enqueue(async () => {
      const result = await this.database.execute(sql, params as unknown as never[])
      // op-sqlite returns `rows` as an array-like with `_array` on older
      // versions and a plain array on >=14. Normalise to a plain array.
      const raw = (result as unknown as { rows?: unknown }).rows ?? []
      const rows = Array.isArray(raw) ? raw : ((raw as { _array?: unknown[] })._array ?? [])
      return rows as ReadonlyArray<T>
    })
  }

  async run(sql: string, params: ReadonlyArray<unknown> = []): Promise<void> {
    await this.enqueue(async () => {
      await this.database.execute(sql, params as unknown as never[])
    })
  }

  async transaction<T>(fn: (transactionDriver: SQLiteDriver) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      // op-sqlite has a `transaction` helper but it locks the driver in a
      // way that fights our serialisation queue. Use raw BEGIN/COMMIT for
      // explicit control + nested-savepoint support if needed.
      await this.database.execute('BEGIN')
      try {
        // Pass `this` (the same driver) so reads/writes inside the
        // transaction body share the same serialisation queue. The
        // queue prevents interleaving from concurrent callers.
        const result = await fn(this.unqueuedDriver())
        await this.database.execute('COMMIT')
        return result
      } catch (err) {
        try {
          await this.database.execute('ROLLBACK')
        } catch {
          // ignore rollback failure; original error is more useful
        }
        throw err
      }
    })
  }

  /**
   * Inside a transaction body, the queue is already held by the outer
   * `enqueue` call; nested calls would deadlock. Return a thin wrapper
   * driver whose methods bypass the queue.
   */
  private unqueuedDriver(): SQLiteDriver {
    const db = this.database
    return {
      async exec(sql: string) {
        await db.execute(sql)
      },
      async query<T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> {
        const result = await db.execute(sql, params as unknown as never[])
        const raw = (result as unknown as { rows?: unknown }).rows ?? []
        return (
          Array.isArray(raw) ? raw : ((raw as { _array?: unknown[] })._array ?? [])
        ) as ReadonlyArray<T>
      },
      async run(sql: string, params: ReadonlyArray<unknown> = []) {
        await db.execute(sql, params as unknown as never[])
      },
      async transaction<T>(fn: (d: SQLiteDriver) => Promise<T>): Promise<T> {
        // Nested transactions = SAVEPOINT.
        const sp = `sp_${Math.random().toString(36).slice(2, 10)}`
        await db.execute(`SAVEPOINT ${sp}`)
        try {
          const r = await fn(this)
          await db.execute(`RELEASE SAVEPOINT ${sp}`)
          return r
        } catch (err) {
          try {
            await db.execute(`ROLLBACK TO SAVEPOINT ${sp}`)
            await db.execute(`RELEASE SAVEPOINT ${sp}`)
          } catch {
            // ignore
          }
          throw err
        }
      },
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    // Swallow rejections so the queue doesn't poison subsequent ops.
    this.queue = next.catch(() => undefined)
    return next
  }
}

export function createOpSqlitePersistence(
  options: OpSqlitePersistenceOptions,
): PersistedCollectionPersistence {
  const driver = new OpSqliteDriver({ database: options.database })
  const adapter = createSQLiteCorePersistenceAdapter({
    driver,
    schemaVersion: options.schemaVersion,
    schemaMismatchPolicy: options.schemaMismatchPolicy ?? 'reset',
  })
  return {
    adapter,
    coordinator: options.coordinator ?? new SingleProcessCoordinator(),
  }
}

export { OpSqliteDriver }
