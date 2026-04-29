// Test helper — minimal drizzle-d1 query-builder stub for vitest.
//
// The real `drizzle-orm/d1` module returns a fluent builder where every
// chained call (`.from`, `.where`, `.orderBy`, `.limit`, …) returns a new
// thenable. Awaiting the chain runs the SQL against D1.
//
// `makeFakeDb` returns a `db` object where `db.select() / .insert() /
// .update() / .delete() / .transaction()` produce a chainable Proxy that
// records the call sequence and resolves to whatever the test queue or
// resolver supplies. Tests can either:
//   • set `data.select` / `.insert` / `.update` / `.delete` to a single
//     array reused for every terminal of that kind, OR
//   • push per-call results onto `data.queue` (FIFO) — useful when one
//     route makes several reads in a row.
//
// `mockDrizzleD1()` installs a vi.mock for `drizzle-orm/d1` that returns
// the fake from `globalThis.__fakeDb`, which `installFakeDb()` sets per
// test. Call mockDrizzleD1() at the TOP of the test file (vi.mock is
// hoisted), and `installFakeDb(db)` inside `beforeEach`.
//
// IMPORTANT: this is intentionally NOT a real ORM. It does not understand
// `eq`, `and`, etc. — it only collects calls and returns whatever the test
// configured. Coverage of the SQL itself belongs in DB-level integration
// tests, not these route tests.

import { vi } from 'vitest'

type Kind = 'select' | 'insert' | 'update' | 'delete'

interface ChainOp {
  kind: Kind
  calls: Array<{ method: string; args: unknown[] }>
}

export interface DbStubData {
  select: unknown[]
  insert: unknown[]
  update: unknown[]
  delete: unknown[]
  /** FIFO queue consumed before the per-kind defaults. */
  queue: unknown[]
  /** Whether transaction(cb) should run cb. Default true. */
  runTransactions: boolean
}

export interface DbStubConfig {
  select?: unknown[]
  insert?: unknown[]
  update?: unknown[]
  delete?: unknown[]
  queue?: unknown[]
  runTransactions?: boolean
}

/**
 * Build a chainable Proxy that resolves (when awaited) to whatever the
 * supplied resolver returns for this op.
 */
function makeChain(op: ChainOp, resolve: (op: ChainOp) => unknown): any {
  const finalize = () => Promise.resolve(resolve(op))

  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        const p = finalize()
        return p.then.bind(p)
      }
      if (prop === 'catch') {
        const p = finalize()
        return p.catch.bind(p)
      }
      if (prop === 'finally') {
        const p = finalize()
        return p.finally.bind(p)
      }
      // For anything else, treat as a fluent method.
      return (...args: unknown[]) => {
        op.calls.push({ method: String(prop), args })
        return makeChain(op, resolve)
      }
    },
  }

  return new Proxy(() => {}, handler)
}

/**
 * Build a fake drizzle `db` object plus a `data` bag for the test to
 * tweak. The `db.transaction(cb)` invokes `cb(db)` so transaction code
 * paths share the same stub state.
 */
export function makeFakeDb(cfg: DbStubConfig = {}) {
  const data: DbStubData = {
    select: cfg.select ?? [],
    insert: cfg.insert ?? [],
    update: cfg.update ?? [],
    delete: cfg.delete ?? [],
    queue: cfg.queue ?? [],
    runTransactions: cfg.runTransactions ?? true,
  }

  const resolver = (op: ChainOp) => {
    if (data.queue.length > 0) {
      return data.queue.shift()
    }
    return data[op.kind]
  }

  const db: any = {
    select: vi.fn((..._args: unknown[]) =>
      makeChain({ kind: 'select', calls: [{ method: 'select', args: _args }] }, resolver),
    ),
    insert: vi.fn((..._args: unknown[]) =>
      makeChain({ kind: 'insert', calls: [{ method: 'insert', args: _args }] }, resolver),
    ),
    update: vi.fn((..._args: unknown[]) =>
      makeChain({ kind: 'update', calls: [{ method: 'update', args: _args }] }, resolver),
    ),
    delete: vi.fn((..._args: unknown[]) =>
      makeChain({ kind: 'delete', calls: [{ method: 'delete', args: _args }] }, resolver),
    ),
    transaction: vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
      if (!data.runTransactions) return undefined
      return cb(db)
    }),
    // D1's `db.batch(ops)` resolves each fluent chain in order — each op
    // is already a thenable Proxy from `makeChain`, so awaiting them
    // delegates to the configured resolver / queue.
    batch: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  }

  return { db, data }
}

/**
 * Bind a fake db so `drizzle()` returns it. Call this from beforeEach
 * after constructing your makeFakeDb().db. The companion `vi.mock`
 * lives in each test file (vi.mock has to be at file top-level so the
 * vitest hoister can lift it).
 */
export function installFakeDb(db: any) {
  ;(globalThis as any).__fakeDb = db
}
