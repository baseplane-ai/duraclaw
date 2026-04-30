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

export interface ChainOp {
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
  const finalize = () => {
    const v = resolve(op)
    // Allow tests to inject failures by queuing an Error instance — the
    // chain rejects when awaited so the calling handler observes a thrown
    // promise (matching real D1 behavior on constraint / network failure).
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  }

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

  // Recording layer: tests can inspect `ops` to verify what `.values()` /
  // `.onConflictDoUpdate()` etc. received. One entry per top-level call to
  // `db.select|insert|update|delete()`; `calls` accumulates every fluent
  // method invocation on that chain.
  const ops: ChainOp[] = []

  const resolver = (op: ChainOp) => {
    if (data.queue.length > 0) {
      return data.queue.shift()
    }
    return data[op.kind]
  }

  const startChain = (kind: Kind, args: unknown[]) => {
    const op: ChainOp = { kind, calls: [{ method: kind, args }] }
    ops.push(op)
    return makeChain(op, resolver)
  }

  const db: any = {
    select: vi.fn((..._args: unknown[]) => startChain('select', _args)),
    insert: vi.fn((..._args: unknown[]) => startChain('insert', _args)),
    update: vi.fn((..._args: unknown[]) => startChain('update', _args)),
    delete: vi.fn((..._args: unknown[]) => startChain('delete', _args)),
    transaction: vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
      if (!data.runTransactions) return undefined
      return cb(db)
    }),
    /**
     * Real D1 `db.batch([...statements])` runs an array of prepared
     * statements atomically and returns their results in order. The fake
     * awaits each chainable in sequence — each chain has already been
     * built (the test handler called `db.update(...)/db.insert(...)`
     * before passing the chain into batch), so `await`-ing it pulls the
     * next item off the FIFO queue exactly like a non-batched call would.
     *
     * If any statement rejects (a queued Error), batch rejects with that
     * same error — mirroring real D1's atomic-rollback semantics from the
     * caller's point of view. Sequential (not Promise.all) so rollback
     * is observable in tests that queue errors mid-batch.
     */
    batch: vi.fn(async (statements: unknown[]) => {
      const results: unknown[] = []
      for (const stmt of statements) {
        results.push(await stmt)
      }
      return results
    }),
  }

  return { db, data, ops }
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
