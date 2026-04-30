/**
 * Unit tests for the op-sqlite SQLiteDriver wrapper.
 *
 * The real op-sqlite ships JSI bindings and only loads on a Metro/RN
 * runtime — we can't open a real connection here. Instead the tests
 * inject a mock `database` whose `execute()` records calls so we can
 * assert that:
 *   - operations serialise via the per-database promise queue
 *   - transactions wrap their body in BEGIN / COMMIT / ROLLBACK
 *   - nested transactions become SAVEPOINT / RELEASE / ROLLBACK TO
 *   - a thrown error in a transaction body fires a ROLLBACK
 *   - the queue survives a rejected operation (subsequent ops still run)
 */

import { describe, expect, it, vi } from 'vitest'
import type { OpSqliteDatabase } from './index'
import { OpSqliteDriver } from './index'

type ExecuteCall = { sql: string; params?: ReadonlyArray<unknown> }

function makeMockDb(impl?: (sql: string) => unknown): {
  database: OpSqliteDatabase
  calls: ExecuteCall[]
} {
  const calls: ExecuteCall[] = []
  const database = {
    execute: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ sql, params })
      const out = impl?.(sql)
      // Default to an empty rowset shaped like op-sqlite's QueryResult.
      return out ?? { rows: [], rowsAffected: 0 }
    }),
  } as unknown as OpSqliteDatabase
  return { database, calls }
}

describe('OpSqliteDriver — basic ops', () => {
  it('exec() runs the SQL through database.execute()', async () => {
    const { database, calls } = makeMockDb()
    const driver = new OpSqliteDriver({ database })
    await driver.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY)')
    expect(calls).toEqual([{ sql: 'CREATE TABLE foo (id INTEGER PRIMARY KEY)', params: undefined }])
  })

  it('run() forwards params', async () => {
    const { database, calls } = makeMockDb()
    const driver = new OpSqliteDriver({ database })
    await driver.run('INSERT INTO foo (id) VALUES (?)', [42])
    expect(calls).toEqual([{ sql: 'INSERT INTO foo (id) VALUES (?)', params: [42] }])
  })

  it('query() normalises modern op-sqlite rows array to plain array', async () => {
    const { database } = makeMockDb((_sql) => ({
      rows: [{ id: 1 }, { id: 2 }],
      rowsAffected: 0,
    }))
    const driver = new OpSqliteDriver({ database })
    const rows = await driver.query<{ id: number }>('SELECT id FROM foo')
    expect(rows).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('query() also handles legacy rows._array shape', async () => {
    const { database } = makeMockDb((_sql) => ({
      rows: { _array: [{ id: 7 }] },
      rowsAffected: 0,
    }))
    const driver = new OpSqliteDriver({ database })
    const rows = await driver.query<{ id: number }>('SELECT id FROM foo')
    expect(rows).toEqual([{ id: 7 }])
  })

  it('query() returns an empty array when rows is missing', async () => {
    const { database } = makeMockDb((_sql) => ({ rowsAffected: 0 }))
    const driver = new OpSqliteDriver({ database })
    const rows = await driver.query<{ id: number }>('SELECT id FROM foo')
    expect(rows).toEqual([])
  })
})

describe('OpSqliteDriver — serialisation queue', () => {
  it('serialises concurrent operations through the queue (FIFO order)', async () => {
    const order: string[] = []
    const database = {
      execute: vi.fn(async (sql: string) => {
        order.push(`start:${sql}`)
        // Yield control so the queue's serialisation is observable —
        // if exec() didn't await the previous queue tick, the next
        // start: would interleave before the first end:.
        await new Promise<void>((r) => setTimeout(r, 0))
        order.push(`end:${sql}`)
        return { rows: [], rowsAffected: 0 }
      }),
    } as unknown as OpSqliteDatabase
    const driver = new OpSqliteDriver({ database })

    await Promise.all([driver.exec('A'), driver.exec('B'), driver.exec('C')])

    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C'])
  })

  it('queue survives a rejected operation — subsequent ops still execute', async () => {
    let invocation = 0
    const database = {
      execute: vi.fn(async (sql: string) => {
        invocation += 1
        if (invocation === 1) throw new Error('boom')
        return { rows: [], rowsAffected: 0 }
      }),
    } as unknown as OpSqliteDatabase
    const driver = new OpSqliteDriver({ database })

    const first = driver.exec('FAIL')
    const second = driver.exec('OK')

    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBeUndefined()
    expect(database.execute).toHaveBeenCalledTimes(2)
  })
})

describe('OpSqliteDriver — transactions', () => {
  it('wraps the body in BEGIN / COMMIT on success', async () => {
    const { database, calls } = makeMockDb()
    const driver = new OpSqliteDriver({ database })

    await driver.transaction(async (tx) => {
      await tx.run('INSERT INTO foo (id) VALUES (?)', [1])
    })

    expect(calls.map((c) => c.sql)).toEqual(['BEGIN', 'INSERT INTO foo (id) VALUES (?)', 'COMMIT'])
  })

  it('issues a ROLLBACK if the body throws', async () => {
    const { database, calls } = makeMockDb()
    const driver = new OpSqliteDriver({ database })

    const err = new Error('aborted')
    await expect(
      driver.transaction(async () => {
        throw err
      }),
    ).rejects.toBe(err)

    expect(calls.map((c) => c.sql)).toEqual(['BEGIN', 'ROLLBACK'])
  })

  it('nested transactions become SAVEPOINT / RELEASE on success', async () => {
    const { database, calls } = makeMockDb()
    const driver = new OpSqliteDriver({ database })

    await driver.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.run('UPDATE foo SET id = 2')
      })
    })

    expect(calls.map((c) => c.sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/^SAVEPOINT sp_[a-z0-9]+$/),
      'UPDATE foo SET id = 2',
      expect.stringMatching(/^RELEASE SAVEPOINT sp_[a-z0-9]+$/),
      'COMMIT',
    ])
  })

  it('nested transaction failure issues ROLLBACK TO SAVEPOINT but outer COMMIT still runs', async () => {
    const { database, calls } = makeMockDb()
    const driver = new OpSqliteDriver({ database })

    await driver.transaction(async (tx) => {
      await expect(
        tx.transaction(async () => {
          throw new Error('inner-fail')
        }),
      ).rejects.toThrow('inner-fail')
      // Outer continues and commits.
      await tx.run('SELECT 1')
    })

    const sqls = calls.map((c) => c.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[1]).toMatch(/^SAVEPOINT sp_[a-z0-9]+$/)
    expect(sqls[2]).toMatch(/^ROLLBACK TO SAVEPOINT sp_[a-z0-9]+$/)
    expect(sqls[3]).toMatch(/^RELEASE SAVEPOINT sp_[a-z0-9]+$/)
    expect(sqls[4]).toBe('SELECT 1')
    expect(sqls[5]).toBe('COMMIT')
  })
})
